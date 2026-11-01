import * as winston from 'winston';

let simpleLogger :winston.Logger|undefined;

export function getSimpleLogger() {
  if (!simpleLogger) {
    simpleLogger = winston.createLogger({
      transports: [
        // stderr: stdout carries command output (--scrape-file JSON)
        new winston.transports.Console({ stderrLevels: Object.keys(winston.config.npm.levels) }),
        new winston.transports.File({ filename: "jscrawl.log" }),
      ],
    });
  }
  return simpleLogger;
}

export { Logger } from 'winston';
