import nodemailer from 'nodemailer';
import type { Config } from '../config';
import type { Logger } from './logger';

export interface Mailer {
  sendResetCode(to: string, code: string): Promise<void>;
}

export function createMailer(config: Config, logger: Logger): Mailer {
  if (!config.SMTP_HOST) {
    // Development only (production config requires SMTP_HOST, see DECISIONS.md D-022).
    return {
      async sendResetCode(to, code) {
        logger.warn({ to }, `SMTP not configured — password reset code: ${code}`);
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });

  return {
    async sendResetCode(to, code) {
      await transport.sendMail({
        from: config.MAIL_FROM,
        to,
        subject: `Your ServerDeck reset code: ${code}`,
        text:
          `Your ServerDeck password reset code is ${code}.\n\n` +
          `It expires in 15 minutes. If you didn't ask for this, you can ignore this email.`,
      });
    },
  };
}
