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

    if (envData.COMMIT_TAG_FREEZE || envData.COMMIT_HASH_FREEZE) {
        return;
    }

    const { gitOrg, gitRepo, platform } = await getGitOrgRepo(engineFolderPath);

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
    const octokit = new Octokit({ auth: core.getInput('token') });

    try {
        const allTags = await octokit.request('GET /repos/{owner}/{repo}/tags', {
            owner: gitOrg,
            repo: gitRepo
        });

        const latestTag = allTags.data[0]?.name;
        if (latestTag && isValidTag(latestTag, currentTag)) {
            issuesFound.push({ engineName, newTag: latestTag, oldTag: currentTag });
        }
    } catch (error) {
        console.error(`Error fetching GitHub tags for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

async function checkGithubCommits(gitOrg, gitRepo, currentHash, issuesFound, engineName) {
    const octokit = new Octokit({ auth: core.getInput('token') });

    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/commits', {
            owner: gitOrg,
            repo: gitRepo
        });

        const latestCommit = response.data[0];

        if (latestCommit && isNewerCommit(currentHash, latestCommit.sha, latestCommit.commit.author.date)) {
            issuesFound.push({ engineName, newHash: latestCommit.sha.substring(0, 7), oldHash: currentHash });
        }
    } catch (error) {
        console.error(`Error fetching GitHub commits for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

async function checkBitbucketTags(gitOrg, gitRepo, currentTag, issuesFound, engineName) {
    try {
        const response = await axios.get(`https://api.bitbucket.org/2.0/repositories/${gitOrg}/${gitRepo}/refs/tags?sort=-target.date`);
        const latestTag = response.data.values[0]?.name;

        if (latestTag && isValidTag(latestTag, currentTag)) {
            issuesFound.push({ engineName, newTag: latestTag, oldTag: currentTag });
        }
    } catch (error) {
        console.error(`Error fetching Bitbucket tags for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

async function checkBitbucketCommits(gitOrg, gitRepo, currentHash, issuesFound, engineName) {
    try {
        const response = await axios.get(`https://api.bitbucket.org/2.0/repositories/${gitOrg}/${gitRepo}/commits`);
        const latestCommit = response.data.values[0];

        if (latestCommit && isNewerCommit(currentHash, latestCommit.hash, latestCommit.date)) {
            issuesFound.push({ engineName, newHash: latestCommit.hash.substring(0, 7), oldHash: currentHash });
        }
    } catch (error) {
        console.error(`Error fetching Bitbucket commits for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

async function checkGitlabTags(gitOrg, gitRepo, currentTag, issuesFound, engineName) {
    try {
        const response = await axios.get(`https://gitlab.com/api/v4/projects/${encodeURIComponent(`${gitOrg}/${gitRepo}`)}/repository/tags`);
        const latestTag = response.data[0]?.name;

        if (latestTag && isValidTag(latestTag, currentTag)) {
            issuesFound.push({ engineName, newTag: latestTag, oldTag: currentTag });
        }
    } catch (error) {
        console.error(`Error fetching GitLab tags for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

async function checkGitlabCommits(gitOrg, gitRepo, currentHash, issuesFound, engineName) {
    try {
        const response = await axios.get(`https://gitlab.com/api/v4/projects/${encodeURIComponent(`${gitOrg}/${gitRepo}`)}/repository/commits`);
        const latestCommit = response.data[0];

        if (latestCommit && isNewerCommit(currentHash, latestCommit.id, latestCommit.created_at)) {
            issuesFound.push({ engineName, newHash: latestCommit.id.substring(0, 7), oldHash: currentHash });
        }
    } catch (error) {
        console.error(`Error fetching GitLab commits for ${gitOrg}/${gitRepo}:`, error.message);
    }
}

function isValidTag(newTag, currentTag) {
    return newTag !== currentTag && !['latest', 'nightly'].includes(newTag.toLowerCase());
}

function isNewerCommit(currentHash, latestHash, latestDateStr) {
    if (currentHash.startsWith(latestHash) || latestHash.startsWith(currentHash)) {
        return false;
    }

    const latestDate = new Date(latestDateStr);
    const oneWeekAfterCurrent = new Date(latestDate);
    oneWeekAfterCurrent.setDate(oneWeekAfterCurrent.getDate() - 7);

    return latestDate > oneWeekAfterCurrent;
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
