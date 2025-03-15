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

    if (envData.COMMIT_TAG_FREEZE || envData.COMMIT_HASH_FREEZE) {
        return;
    }

    if(!envData.COMMIT_TAG && !envData.COMMIT_HASH) {
        return;
    }

    const repoInfo = await getGitOrgRepo(engineFolderPath);

    if (!repoInfo) {
        console.warn(`No valid Git repository found for engine: ${engineName}`);
        return;
    }

    const { gitOrg, gitRepo, platform } = repoInfo;

    console.log(`Checking git org ${gitOrg}, repo ${gitRepo} on ${platform}`);

    if (platform === 'github') {
        if (envData.COMMIT_TAG) {
            await checkGithubTags(gitOrg, gitRepo, envData.COMMIT_TAG, issuesFound, engineName);
        }
        if (envData.COMMIT_HASH) {
            await checkGithubCommits(gitOrg, gitRepo, envData.COMMIT_HASH, issuesFound, engineName);
        }
    } else if (platform === 'bitbucket') {
        if (envData.COMMIT_TAG) {
            await checkBitbucketTags(gitOrg, gitRepo, envData.COMMIT_TAG, issuesFound, engineName);
        }
        if (envData.COMMIT_HASH) {
            await checkBitbucketCommits(gitOrg, gitRepo, envData.COMMIT_HASH, issuesFound, engineName);
        }
    } else if (platform === 'gitlab') {
        if (envData.COMMIT_TAG) {
            await checkGitlabTags(gitOrg, gitRepo, envData.COMMIT_TAG, issuesFound, engineName);
        }
        if (envData.COMMIT_HASH) {
            await checkGitlabCommits(gitOrg, gitRepo, envData.COMMIT_HASH, issuesFound, engineName);
        }
    }
}

async function checkGithubTags(gitOrg, gitRepo, currentTag, issuesFound, engineName) {
    const octokit = new Octokit({ auth: core.getInput('github_token') });

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

async function checkGithubCommits(gitOrg, gitRepo, currentHash, issuesFound, engineName) {
    const octokit = new Octokit({ auth: core.getInput('token') });

    try {
        // Get latest commit
        const response = await octokit.request('GET /repos/{owner}/{repo}/commits', {
            owner: gitOrg,
            repo: gitRepo
        });

        const latestCommit = response.data[0];

        // Get current commit's date
        const currentCommitResponse = await octokit.request('GET /repos/{owner}/{repo}/commits/{sha}', {
            owner: gitOrg,
            repo: gitRepo,
            sha: currentHash
        });

        const currentCommitDate = currentCommitResponse.data.commit.author.date;

        if (latestCommit && isNewerCommit(currentHash, latestCommit.sha, latestCommit.commit.author.date, currentCommitDate)) {
            issuesFound.push({ engineName, newHash: latestCommit.sha.substring(0, 7), oldHash: currentHash });
        }
    } catch (error) {
        console.error(`Error fetching GitHub commits for ${gitOrg}/${gitRepo}:`, error.message);
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

async function checkBitbucketCommits(gitOrg, gitRepo, currentHash, issuesFound, engineName) {
    try {
        // Get latest commit
        const response = await axios.get(`https://api.bitbucket.org/2.0/repositories/${gitOrg}/${gitRepo}/commits`);
        const latestCommit = response.data.values[0];

        // Get current commit's date
        const currentCommitResponse = await axios.get(`https://api.bitbucket.org/2.0/repositories/${gitOrg}/${gitRepo}/commit/${currentHash}`);
        const currentCommitDate = currentCommitResponse.data.date;

        if (latestCommit && isNewerCommit(currentHash, latestCommit.hash, latestCommit.date, currentCommitDate)) {
            issuesFound.push({ engineName, newHash: latestCommit.hash.substring(0, 7), oldHash: currentHash });
        }
    } catch (error) {
        console.error(`Error fetching Bitbucket commits for ${gitOrg}/${gitRepo}:`, error.message);
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

async function checkGitlabCommits(gitOrg, gitRepo, currentHash, issuesFound, engineName) {
    try {
        // Get latest commit
        const response = await axios.get(`https://gitlab.com/api/v4/projects/${encodeURIComponent(`${gitOrg}/${gitRepo}`)}/repository/commits`);
        const latestCommit = response.data[0];

        // Get current commit's date
        const currentCommitResponse = await axios.get(
            `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${gitOrg}/${gitRepo}`)}/repository/commits/${currentHash}`
        );
        const currentCommitDate = currentCommitResponse.data.committed_date;

        if (latestCommit && isNewerCommit(currentHash, latestCommit.id, latestCommit.committed_date, currentCommitDate)) {
            issuesFound.push({ engineName, newHash: latestCommit.id.substring(0, 7), oldHash: currentHash });
        }
    } catch (error) {
        console.error(`Error fetching GitLab commits for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

function isValidTag(newTag, currentTag) {
    return newTag !== currentTag && !['latest', 'nightly'].includes(newTag.toLowerCase());
}

function isNewerCommit(currentHash, latestHash, latestDateStr, currentDateStr) {
    if (currentHash.startsWith(latestHash) || latestHash.startsWith(currentHash)) {
        return false; // Same commit, no update needed
    }

    const latestDate = new Date(latestDateStr);
    const currentDate = new Date(currentDateStr);

    // Check if the latest commit is at least 7 days newer than the current commit
    const oneWeekAfterCurrent = new Date(currentDate);
    oneWeekAfterCurrent.setDate(oneWeekAfterCurrent.getDate() + 7);

    return latestDate >= oneWeekAfterCurrent;
}

async function run() {
    try {
        const engineNames = await fs.readdir(packagesEnginesPath);
        const issuesFound = [];

        for (let engine of engineNames) {
            await checkEngine(engine, issuesFound);
        }

        core.setOutput('matrix', JSON.stringify({ include: issuesFound }));
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
