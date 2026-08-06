import pino from 'pino';
import dotenv from 'dotenv';
dotenv.config();

const logger = pino({
    level: process.env.LOG_LEVEL || 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
                colorize: true,
                ignore: 'pid,hostname',
                translateTime: 'SYS:standard',
            }
        }
});

export { logger };
