import { createLogger, loadConfig, workerConfig } from '@ryze/core';

const config = loadConfig(workerConfig);
createLogger('worker', config.LOG_LEVEL).info('worker: the step runner arrives in milestone 3');
