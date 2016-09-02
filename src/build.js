// npm packages
import fs from 'fs';
import got from 'got';
import tar from 'tar-fs';
import path from 'path';
import chalk from 'chalk';
import minimatch from 'minimatch';
import spinner from 'char-spinner';
import inquirer from 'inquirer';

// our packages
import config from './config';
import detectTemplate from './templates';
import {handleError} from './error';

// text cleanup
const cleanText = (txt) => txt.trim().replace(/[\n\r]/g, '');

export default (yargs) =>
  yargs.command('build', 'build current folder using exoframe server', {
    tag: {
      alias: 't',
    },
    noninteractive: {
      alias: 'ni',
    },
    verbose: {
      alias: 'v',
    },
  }, async ({tag, noninteractive, verbose}) => {
    console.log(chalk.bold('Building current folder using endpoint:'), config.endpoint);
    // create config vars
    const remoteUrl = `${config.endpoint}/api/build`;
    const workdir = process.cwd();

    // get templates based on workdir
    const template = detectTemplate(workdir);
    if (!template) {
      console.error(chalk.red('Error!'), 'Could not detect template for current project!');
      return;
    }

    let userTag = tag || workdir.split('/').pop().trim();
    let userLabels = {};
    if (!noninteractive) {
      // get user custom tag
      const {userInputTag, userInputLabels} = await inquirer
      .prompt([{
        type: 'input',
        name: 'userInputTag',
        message: 'Image tag:',
        default: userTag,
      }, {
        type: '',
        name: 'userInputLabels',
        message: 'Custom labels (comma separated):',
      }]);
      userTag = userInputTag;
      userLabels = userInputLabels ?
        userInputLabels
          .split(',')
          .map(it => it.trim())
          .filter(it => it.includes('='))
          .reduce((sum, el) => {
            const [k, v] = el.split('=');
            return {
              [k]: v,
              ...sum,
            };
          }, {}) :
        userLabels;
    }

    if (!noninteractive && template.interactive) {
      await template.interactive(inquirer);
    }

    // check template dockerfile
    if (!template.dockerfile || !template.dockerfile.length) {
      console.error(chalk.red('Error!'), 'Template Dockerfile is empty!');
      return;
    }

    // metadata
    const buildTag = userTag || tag;
    const dockerfilePath = path.join(workdir, 'Dockerfile');
    const labels = {
      ...template.labels,
      ...userLabels,
      'exoframe.user': config.user.username,
    };

    // check if dockerfile already exists
    let deleteDockerfile = false;
    try {
      fs.accessSync(dockerfilePath);
    } catch (e) {
      // if no - write new dockerfile
      fs.writeFileSync(dockerfilePath, template.dockerfile, 'utf8');
      // say we need to delete dockerfile later
      deleteDockerfile = true;
    }

    // create tar stream from current folder
    const tarStream = tar.pack(workdir, {ignore: (name) => template.ignores.some(ignore => minimatch(name, ignore))});

    const options = {
      headers: {
        'x-access-token': config.token,
      },
      query: {
        tag: buildTag,
        labels: JSON.stringify(labels),
      },
    };

    // render spinner
    let spinnerInterval;
    if (!verbose) {
      spinnerInterval = spinner();
    }
    const cleanUp = () => {
      if (deleteDockerfile) {
        try {
          fs.unlinkSync(dockerfilePath);
        } catch (e) {
          console.log('error deleting dockerfile:', e);
        }
      }
      // stop spinner
      if (!verbose) {
        clearInterval(spinnerInterval);
      }
    };
    // pipe stream to remote
    const stream = tarStream.pipe(got.stream.post(remoteUrl, options));
    // log output if in verbose mode
    if (verbose) {
      stream.on('data', (str) => {
        const text = str.toString().split('\n');
        text.filter(t => t && t.length).forEach(t => {
          try {
            const data = JSON.parse(t);
            console.log(cleanText(data.stream));
          } catch (e) {
            console.log(cleanText(t));
          }
        });
      });
    }
    // listen for stream finish
    stream.on('finish', () => {
      cleanUp();
      // log end
      console.log(chalk.bold('Done building!'), `Your images is now available as ${buildTag}`);
    });
    // listen for stream errors
    stream.on('error', (e) => {
      // do delayed cleanup
      setTimeout(cleanUp, 100);
      // try generic error handling first
      if (handleError(e)) {
        return;
      }
      // log other errors
      console.log(chalk.bold('Error during build!'));
      console.error(e);
    });
  });
