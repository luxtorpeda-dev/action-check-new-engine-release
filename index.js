import { createRequire } from "module";
const require = createRequire(import.meta.url);

const core = require('@actions/core');
const { context, GitHub } = require('@actions/github');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
import { Octokit } from "octokit";

const packagesEnginesPath = 'engines';

console.log('Starting.');

async function checkEngine(engineName, issuesFound) {
    const engineFolderPath = path.join(packagesEnginesPath, engineName);
    const envJsonPath = path.join(engineFolderPath, 'env.json');

    try {
        await fs.access(envJsonPath);
    } catch {
        return;
    }

    const envJsonStr = await fs.readFile(envJsonPath, 'utf-8');
    const envData = JSON.parse(envJsonStr);

    if (!envData.COMMIT_TAG || envData.COMMIT_TAG_FREEZE) {
        return;
    }

    const { gitOrg, gitRepo, platform } = await getGitOrgRepo(engineFolderPath);

    console.log(`checking git org ${gitOrg} repo ${gitRepo} on ${platform}`);

    if (platform === 'github') {
        await checkGithubTags(gitOrg, gitRepo, envData.COMMIT_TAG, issuesFound, engineName);
    } else if (platform === 'bitbucket') {
        await checkBitbucketTags(gitOrg, gitRepo, envData.COMMIT_TAG, issuesFound, engineName);
    } else if (platform === 'gitlab') {
        await checkGitlabTags(gitOrg, gitRepo, envData.COMMIT_TAG, issuesFound, engineName);
    }
}

async function checkGithubTags(gitOrg, gitRepo, currentTag, issuesFound, engineName) {
    const octokit = new Octokit({
        auth: core.getInput('token')
    });

    try {
        const latestRelease = await octokit.request('GET /repos/{owner}/{repo}/releases/latest', {
            owner: gitOrg,
            repo: gitRepo,
            headers: { 'X-GitHub-Api-Version': '2022-11-28' }
        });

        const latestTag = latestRelease?.data?.tag_name;
        if (latestTag && isValidTag(latestTag, currentTag)) {
            issuesFound.push({ engineName, newTag: latestTag, oldTag: currentTag });
        }
    } catch {
        try {
            const allTags = await octokit.request('GET /repos/{owner}/{repo}/tags', {
                owner: gitOrg,
                repo: gitRepo,
                headers: { 'X-GitHub-Api-Version': '2022-11-28' }
            });

            const latestTag = allTags.data[0]?.name;
            if (latestTag && isValidTag(latestTag, currentTag)) {
                issuesFound.push({ engineName, newTag: latestTag, oldTag: currentTag });
            }
        } catch {}
    }
}

async function checkBitbucketTags(gitOrg, gitRepo, currentTag, issuesFound, engineName) {
    try {
        const response = await axios.get(
            `https://api.bitbucket.org/2.0/repositories/${gitOrg}/${gitRepo}/refs/tags?sort=-target.date`
        );

        const tags = response.data.values.map(tag => tag.name);

        if (tags.length > 0) {
            const latestTag = tags[0]; // Now properly sorted by creation date
            if (isValidTag(latestTag, currentTag)) {
                issuesFound.push({ engineName, newTag: latestTag, oldTag: currentTag });
            }
        }
    } catch (error) {
        console.error(`Error fetching Bitbucket tags for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

async function checkGitlabTags(gitOrg, gitRepo, currentTag, issuesFound, engineName) {
    try {
        const response = await axios.get(
            `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${gitOrg}/${gitRepo}`)}/repository/tags`
        );

        const tags = response.data;
        if (tags.length > 0) {
            const latestTag = tags[0].name;
            if (isValidTag(latestTag, currentTag)) {
                issuesFound.push({ engineName, newTag: latestTag, oldTag: currentTag });
            }
        }
    } catch (error) {
        console.error(`Error fetching GitLab tags for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

// Helper function to check if the tag is valid (not "latest" or "nightly")
function isValidTag(newTag, currentTag) {
    const invalidTags = ['latest', 'nightly'];
    return newTag !== currentTag && !invalidTags.includes(newTag.toLowerCase());
}

async function getGitOrgRepo(enginePath) {
    const buildFilePath = path.join(enginePath, 'build.sh');
    const buildFileStr = await fs.readFile(buildFilePath, 'utf-8');
    const buildFileArr = buildFileStr.split('\n');

    let sourcePushdFound = false;
    let gitCloneLine = '';
    for (let i = 0; i < buildFileArr.length; i++) {
        const line = buildFileArr[i];

        if (sourcePushdFound && !line.includes('git checkout')) {
            break;
        }

        if (sourcePushdFound) {
            const gitCloneUrl = gitCloneLine.split('git clone ')[1].split(' ')[0];

            if (gitCloneUrl.includes('github.com')) {
                const gitArr = gitCloneUrl.split('https://github.com/')[1].split('/');
                return { gitRepo: gitArr[1].replace('.git', ''), gitOrg: gitArr[0], platform: 'github' };
            }

            if (gitCloneUrl.includes('bitbucket.org')) {
                const gitArr = gitCloneUrl.split('https://bitbucket.org/')[1].split('/');
                return { gitRepo: gitArr[1].replace('.git', ''), gitOrg: gitArr[0], platform: 'bitbucket' };
            }

            if (gitCloneUrl.includes('gitlab.com')) {
                const gitArr = gitCloneUrl.split('https://gitlab.com/')[1].split('/');
                return { gitRepo: gitArr[1].replace('.git', ''), gitOrg: gitArr[0], platform: 'gitlab' };
            }
        }

        if (line === 'pushd source') {
            gitCloneLine = buildFileArr[i - 1];
            sourcePushdFound = true;
        }
    }
}

async function run() {
    try {
        const engineNames = await fs.readdir(packagesEnginesPath);
        const issuesFound = [];

        for (let engine of engineNames) {
            await checkEngine(engine, issuesFound);
        }

        console.info(`issuesFound: ${JSON.stringify(issuesFound, null, 4)}`);

        const matrix = issuesFound.length ? { include: issuesFound } : {};

        core.setOutput('matrix', JSON.stringify(matrix));
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
