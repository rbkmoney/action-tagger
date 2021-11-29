import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from '@octokit/core'
import {OctokitResponse} from '@octokit/types'
import {components} from '@octokit/openapi-types'
import semver, {ReleaseType} from 'semver'
import {PaginateInterface} from '@octokit/plugin-paginate-rest'
import {Api} from '@octokit/plugin-rest-endpoint-methods/dist-types/types'

export declare type AnyResponse = OctokitResponse<any>
export declare type TagSchema = components['schemas']['tag']

if (github.context.payload.repository?.owner.login === undefined) {
  throw Error("Repository owner can't be null")
}
if (github.context.payload.repository?.name === undefined) {
  throw Error("Repository name can't be null")
}

const owner = github.context.payload.repository.owner.login
const repo = github.context.payload.repository.name

async function checkTag(
  octokit: Octokit & Api & {paginate: PaginateInterface},
  tagName: any
): Promise<boolean> {
  const {data} = await octokit.rest.repos.listTags({
    owner,
    repo
  })

  if (data) {
    const result = data.filter(tag => tag.name === tagName)

    if (result.length) {
      return true
    }
  }

  return false
}

async function getLatestTag(
  octokit: Octokit & Api & {paginate: PaginateInterface},
  boolAll = true
): Promise<TagSchema | undefined> {
  const {data} = await octokit.rest.repos.listTags({
    owner,
    repo
  })

  // ensure the highest version number is the last element
  // strip all non version tags
  const allVTags = data.filter(tag => semver.clean(tag.name) !== null)

  allVTags.sort((a, b) =>
    semver.compare(semver.clean(a.name)!!, semver.clean(b.name)!!)
  )

  if (boolAll) {
    return allVTags.pop()!!
  }

  // filter prereleases
  // core.info("filter only main releases");

  const filtered = allVTags.filter(b => semver.prerelease(b.name) === null)
  const result = filtered.pop()

  return result
}

async function loadBranch(
  octokit: Octokit & Api & {paginate: PaginateInterface},
  branch: string
): Promise<any> {
  const result = await octokit.rest.git.listMatchingRefs({
    owner,
    repo,
    ref: `heads/${branch}`
  })

  // core.info(`branch data: ${ JSON.stringify(result.data, undefined, 2) } `);
  return result.data.shift()
}

async function checkMessages(
  octokit: Octokit & Api & {paginate: PaginateInterface},
  branchHeadSha: string,
  tagSha: string | undefined,
  issueTags: string[]
): Promise<string> {
  const sha = branchHeadSha

  // core.info(`load commits since ${sha}`);

  let releaseBump = 'none'

  const result = await octokit.rest.repos.listCommits({
    owner,
    repo,
    sha
  })

  if (!(result && result.data)) {
    return releaseBump
  }

  const wip = new RegExp('#wip\\b')
  const major = new RegExp('#major\\b')
  const minor = new RegExp('#minor\\b')
  const patch = new RegExp('#patch\\b')

  const fix = new RegExp('fix(?:es)? #\\d+')
  const matcher = new RegExp(/fix(?:es)? #(\d+)\b/)

  for (const commit of result.data) {
    // core.info(commit.message);
    const message = commit.commit.message

    if (commit.sha === tagSha) {
      break
    }
    // core.info(`commit is : "${JSON.stringify(commit.commit, undefined, 2)}"`);
    // core.info(`message is : "${message}" on ${commit.commit.committer.date} (${commit.sha})`);

    if (wip.test(message)) {
      // core.info("found wip message, skip");
      continue
    }

    if (major.test(message)) {
      // core.info("found major tag, stop");
      return 'major'
    }

    if (minor.test(message)) {
      // core.info("found minor tag");

      releaseBump = 'minor'
      continue
    }

    if (releaseBump !== 'minor' && patch.test(message)) {
      // core.info("found patch tag");
      releaseBump = 'patch'
      continue
    }

    if (releaseBump !== 'minor' && fix.test(message)) {
      // core.info("found a fix message, check issue for enhancements");

      const id = matcher.exec(message)

      if (id && Number(id[1]) > 0) {
        const issue_number = Number(id[1])

        core.info(`check issue ${issue_number} for minor labels`)

        const {data} = await octokit.rest.issues.get({
          owner,
          repo,
          issue_number
        })

        if (data) {
          releaseBump = 'patch'

          for (const label of data.labels) {
            if (typeof label === 'object') {
              const name = label.name || 'empty'
              if (issueTags.includes(name)) {
                core.info('found enhancement issue')
                releaseBump = 'minor'
                break
              }
            }
          }
        }
      }

      // continue;
    }
    // core.info("no info message");
  }

  return releaseBump
}

function isReleaseBranch(branchName: string, branchList: string): boolean {
  for (const branch of branchList.split(',').map(b => b.trim())) {
    const testBranchName = new RegExp(branch)

    if (testBranchName.test(branchName)) {
      return true
    }
  }
  return false
}

async function action(): Promise<void> {
  core.info(`run for ${owner} / ${repo}`)

  // core.info(`payload ${JSON.stringify(github.context.payload.repository, undefined, 2)}`);

  // prepare octokit
  const token = core.getInput('github-token', {required: true})
  const octokit = github.getOctokit(token)

  // load inputs
  // const customTag     = core.getInput('custom-tag');
  const dryRun: string = core.getInput('dry-run').toLowerCase()
  const level: string = core.getInput('bump')
  const forceBranch: string = core.getInput('branch')
  const releaseBranch: string = core.getInput('release-branch')
  const withV: string =
    core.getInput('with-v').toLowerCase() === 'false' ? '' : 'v'
  const customTag: string = core.getInput('tag')
  const issueLabels: string = core.getInput('issue-labels')

  let branchInfo
  let nextVersion

  if (forceBranch) {
    core.info(`check forced branch ${forceBranch}`)

    branchInfo = await loadBranch(octokit, forceBranch)

    if (!branchInfo) {
      throw new Error('unknown branch provided')
    }

    core.info('branch confirmed, continue')
  }

  if (!branchInfo) {
    const activeBranch = github.context.ref.replace(/refs\/heads\//, '')

    core.info(
      `load the history of activity-branch ${activeBranch} from context ref ${github.context.ref}`
    )
    branchInfo = await loadBranch(octokit, activeBranch)

    if (!branchInfo) {
      throw new Error(`failed to load branch ${activeBranch}`)
    }
  }

  // the sha for tagging
  const sha: string = branchInfo.object.sha
  const branchName: string | undefined = branchInfo.ref.split('/').pop()

  core.info(`active branch name is ${branchName}`)

  if (customTag) {
    const checkTagResult = await checkTag(octokit, customTag)
    if (checkTagResult) {
      throw new Error(`tag already exists ${customTag}`)
    }

    core.setOutput('new-tag', customTag)
  } else {
    core.info(`maching refs: ${sha}`)

    const latestTag = await getLatestTag(octokit)
    const latestMainTag = await getLatestTag(octokit, false)

    core.info(
      `the previous tag of the repository ${JSON.stringify(
        latestTag,
        undefined,
        2
      )}`
    )
    core.info(
      `the previous main tag of the repository ${JSON.stringify(
        latestMainTag,
        undefined,
        2
      )}`
    )

    const versionTag = latestTag ? latestTag.name : '0.0.0'

    core.setOutput('tag', versionTag)

    if (latestTag && latestTag.commit.sha === sha) {
      throw new Error('no new commits, avoid tagging')
    }

    core.info(`The repo tags: ${JSON.stringify(latestTag, undefined, 2)}`)

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const version = semver.clean(versionTag)!!

    nextVersion = semver.inc(version, 'prerelease', branchName)

    core.info(`default to prerelease version ${nextVersion}`)

    let issLabs: string[] = ['enhancement']

    if (issueLabels) {
      const xlabels = issueLabels.split(',').map(lab => lab.trim())

      if (xlabels.length) {
        issLabs = xlabels
      }
    }

    // check if commits and issues point to a diffent release
    core.info('commits in branch')
    const msgLevel = await checkMessages(
      octokit,
      branchInfo.object.sha,
      latestMainTag?.commit.sha,
      issLabs
    )
    // core.info(`commit messages suggest ${msgLevel} upgrade`);

    if (isReleaseBranch(branchName!!, releaseBranch)) {
      core.info(`${branchName} is a release branch`)

      if (msgLevel === 'none') {
        const releaseType = level as ReleaseType
        nextVersion = semver.inc(version, releaseType)
      } else {
        core.info(`commit messages force bump level to ${msgLevel}`)
        const releaseType = msgLevel as ReleaseType
        nextVersion = semver.inc(version, releaseType)
      }
    }

    core.info(`bump tag ${nextVersion}`)

    core.setOutput('new-tag', nextVersion)
  }

  if (dryRun === 'true') {
    core.info("dry run, don't perform tagging")
    return
  }

  const newTag = `${withV}${nextVersion}`

  core.info(`really add tag ${customTag ? customTag : newTag}`)

  const ref = `refs/tags/${customTag ? customTag : newTag}`

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref,
    sha
  })
}

action()
  // eslint-disable-next-line github/no-then
  .then(() => core.info('success'))
  // eslint-disable-next-line github/no-then
  .catch(error => core.setFailed(error.message))
