import { createRequire } from "module";
const require = createRequire(import.meta.url);

const core = require('@actions/core');
const { context, GitHub } = require('@actions/github');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
import { Octokit, App } from "octokit";

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

    if(!envData.COMMIT_TAG) {
        return;
    }

    if(envData.COMMIT_TAG_FREEZE) {
        return;
    }

    const {gitOrg, gitRepo} = await getGithubOrgRepo(engineFolderPath);

    const octokit = new Octokit({
        auth: core.getInput('token')
    });

    try {
        const latestRelease = await octokit.request('GET /repos/{owner}/{repo}/releases/latest', {
            owner: gitOrg,
            repo: gitRepo,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        if(latestRelease?.data?.tag_name && latestRelease.data?.tag_name !== envData.COMMIT_TAG) {
            issuesFound.push({
                engineName: engineName,
                newTag: latestRelease.data.tag_name,
                oldTag: envData.COMMIT_TAG
            });
        }
    } catch {
        try {
            const allTags = await octokit.request('GET /repos/{owner}/{repo}/tags', {
                owner: gitOrg,
                repo: gitRepo,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const latestTag = allTags.data[0].name;
            if(latestTag !== envData.COMMIT_TAG) {
                issuesFound.push({
                    engineName: engineName,
                    newTag: latestTag,
                    oldTag: envData.COMMIT_TAG
                });
            }
        }
        catch {}
    }
}

async function getGithubOrgRepo(enginePath) {
    const buildFilePath = path.join(enginePath, 'build.sh');
    const buildFileStr = await fs.readFile(buildFilePath, 'utf-8');
    const buildFileArr = buildFileStr.split('\n');

    let sourcePushdFound = false;
    let gitCloneLine = '';
    for(let i = 0; i < buildFileArr.length; i++) {
        const line = buildFileArr[i];

        if(sourcePushdFound && !line.includes('git checkout')) {
            break;
        }

        if(sourcePushdFound) {
            let commitHash = '';

            const gitCloneUrl = gitCloneLine.split('git clone ')[1].split(' ')[0];

            if(gitCloneUrl.includes('github.com')) {
                const gitArr = gitCloneUrl.split('https://github.com/')[1].split('/');
                const gitOrg = gitArr[0];
                const gitRepo = gitArr[1].replace('.git', '');

                return {gitRepo, gitOrg};
            }
        }

        if(line === 'pushd source') {
            gitCloneLine = buildFileArr[i - 1];
            sourcePushdFound = true;
        }
    }
}

async function run() {
    try {
        const engineNames = await fs.readdir(packagesEnginesPath);

        const issuesFound = [];

        for(let engine of engineNames) {
            await checkEngine(engine, issuesFound);
        }

        console.info(`issuesFound: ${JSON.stringify(issuesFound, null, 4)}`);

        const matrix = {};

        if(issuesFound.length) {
            matrix.include = [];
        }
        
        for(let downloadIssue of issuesFound) {
            matrix.include.push(downloadIssue);
        }
        
        core.setOutput('matrix', JSON.stringify(matrix));
    }
    catch (error) {
        core.setFailed(error.message);
    }
}

run();
