/**
 * notification-core/infrastructure/console/ConsoleEmailLogger.ts
 *
 * A concrete EmailLogger adapter that writes structured notification events to
 * the Node.js console. Suitable for development, testing, and server-side
 * diagnostic output in production environments that capture stdout/stderr.
 *
 * Level mapping:
 *   debug  → console.debug
 *   info   → console.info
 *   warn   → console.warn
 *   error  → console.error
 */
import type { EmailLogger, NotificationLogEvent } from '../../domain/EmailLogger.js';
import type { NotificationConfig } from '../../config/NotificationConfig.js';
/**
 * ConsoleEmailLogger writes notification events to the Node.js console.
 *
 * Usage:
 * ```ts
 * const logger = new ConsoleEmailLogger('info');
 * const useCase = new SendEmailUseCase({ provider, config, logger });
 * ```
 */
export declare class ConsoleEmailLogger implements EmailLogger {
    private readonly minLevel;
    /**
     * @param logLevel - Minimum log level to emit. Events below this level are
     *   silently dropped. Defaults to `'info'`.
     */
    constructor(logLevel?: NotificationConfig['logLevel']);
    log(event: NotificationLogEvent): void;
}
//# sourceMappingURL=ConsoleEmailLogger.d.ts.map