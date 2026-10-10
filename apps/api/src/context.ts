import type { Config } from './config';
import type { Logger } from './lib/logger';
import type { Mailer } from './lib/mailer';
import type { TokenService } from './services/tokens';

export interface AppContext {
  config: Config;
  logger: Logger;
  mailer: Mailer;
  tokens: TokenService;
}
