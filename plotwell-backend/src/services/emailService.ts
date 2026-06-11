import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);

const DEBUG_AI = process.env.DEBUG_AI === 'true';

export interface CollaboratorInvitationData {
  to: string;
  inviterName: string;
  projectName: string;
  role: string;
  inviteUrl: string;
  personalMessage?: string;
  expiresAt: string;
}

export interface PaymentEmailData {
  to: string;
}

export interface WelcomeEmailData extends PaymentEmailData {
  isTrialing: boolean;
  billingCycle: 'monthly' | 'yearly';
  periodEnd: string; // ISO date
}

export interface RenewalEmailData extends PaymentEmailData {
  amount: string; // e.g. "€9.00"
  nextRenewal: string; // ISO date
}

export interface PaymentFailedEmailData extends PaymentEmailData {}

export interface CancelledEmailData extends PaymentEmailData {}

export interface CreditsEmailData extends PaymentEmailData {
  creditsAmount: number;
  newBalance: number;
}

export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    // Initialize SMTP transporter
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: false, // Use STARTTLS
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }

  /**
   * Send a collaborator invitation email
   */
  async sendCollaboratorInvitation(data: CollaboratorInvitationData): Promise<void> {
    try {
      // Load email template
      // __dirname will be dist/services/ after compilation, so go up two levels to project root
      const templatePath = path.join(__dirname, '../..', 'email-templates', 'collaborator-invitation.html');
      let htmlContent = fs.readFileSync(templatePath, 'utf-8');

      // Format personal message with styling if present
      const personalMessageHtml = data.personalMessage
        ? `<div class="personal-message"><p>"${this.escapeHtml(data.personalMessage)}"</p></div>`
        : '';

      // Replace template variables (personalMessage is already HTML, don't escape it)
      htmlContent = this.replaceVariables(
        htmlContent,
        {
          inviterName: data.inviterName,
          projectName: data.projectName,
          role: this.formatRole(data.role),
          inviteUrl: data.inviteUrl,
          personalMessage: personalMessageHtml,
          expiresAt: this.formatExpirationDate(data.expiresAt),
        },
        ['personalMessage'] // Don't escape these variables
      );

      // Send email
      await this.transporter.sendMail({
        from: `${process.env.SMTP_FROM_NAME} <${process.env.SMTP_FROM_EMAIL}>`,
        to: data.to,
        subject: `You've been invited to collaborate on ${data.projectName}`,
        html: htmlContent,
      });

      if (DEBUG_AI) console.log(`Collaborator invitation email sent to ${data.to}`);
    } catch (error) {
      console.error('Failed to send collaborator invitation email:', error);
      throw new Error(`Email sending failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Send welcome email when a new subscription starts (trial or paid)
   */
  async sendWelcomeEmail(data: WelcomeEmailData): Promise<void> {
    try {
      const htmlContent = this.loadAndFillTemplate('payment-welcome.html', {
        trialMessage: data.isTrialing
          ? `Your ${TRIAL_DAYS}-day free trial has started. Your card will not be charged until the trial ends.`
          : 'Your Pro subscription is now active.',
        billingCycle: data.billingCycle,
        periodLabel: data.isTrialing ? 'Trial ends' : 'Next renewal',
        periodDate: this.formatDate(data.periodEnd),
        appUrl: `${process.env.FRONTEND_URL}/projects`,
      });

      await this.sendMail(data.to, 'Welcome to plotwell Pro!', htmlContent);
    } catch (error) {
      console.error('Failed to send welcome email:', error);
      // Don't throw - email failure should not block webhook processing
    }
  }

  /**
   * Send payment renewal confirmation
   */
  async sendRenewalEmail(data: RenewalEmailData): Promise<void> {
    try {
      const htmlContent = this.loadAndFillTemplate('payment-renewed.html', {
        amount: data.amount,
        nextRenewal: this.formatDate(data.nextRenewal),
      });

      await this.sendMail(data.to, 'Payment confirmed - plotwell', htmlContent);
    } catch (error) {
      console.error('Failed to send renewal email:', error);
    }
  }

  /**
   * Send payment failed notification
   */
  async sendPaymentFailedEmail(data: PaymentFailedEmailData): Promise<void> {
    try {
      const htmlContent = this.loadAndFillTemplate('payment-failed.html', {
        updatePaymentUrl: `${process.env.FRONTEND_URL}/projects?view=billing`,
      });

      await this.sendMail(data.to, 'Payment failed - plotwell', htmlContent);
    } catch (error) {
      console.error('Failed to send payment failed email:', error);
    }
  }

  /**
   * Send subscription cancelled confirmation
   */
  async sendCancelledEmail(data: CancelledEmailData): Promise<void> {
    try {
      const htmlContent = this.loadAndFillTemplate('payment-cancelled.html', {
        resubscribeUrl: `${process.env.FRONTEND_URL}/projects?view=plans`,
      });

      await this.sendMail(data.to, 'Subscription cancelled - plotwell', htmlContent);
    } catch (error) {
      console.error('Failed to send cancelled email:', error);
    }
  }

  /**
   * Send AI credits purchase confirmation
   */
  async sendCreditsEmail(data: CreditsEmailData): Promise<void> {
    try {
      const htmlContent = this.loadAndFillTemplate('payment-credits.html', {
        creditsAmount: String(data.creditsAmount),
        newBalance: String(data.newBalance),
      });

      await this.sendMail(data.to, 'AI credits added - plotwell', htmlContent);
    } catch (error) {
      console.error('Failed to send credits email:', error);
    }
  }

  /**
   * Load a template and fill in variables
   */
  private loadAndFillTemplate(templateName: string, variables: Record<string, string>): string {
    const templatePath = path.join(__dirname, '../..', 'email-templates', templateName);
    const html = fs.readFileSync(templatePath, 'utf-8');
    return this.replaceVariables(html, variables);
  }

  /**
   * Send an email via the transporter
   */
  private async sendMail(to: string, subject: string, html: string): Promise<void> {
    await this.transporter.sendMail({
      from: `${process.env.SMTP_FROM_NAME} <${process.env.SMTP_FROM_EMAIL}>`,
      to,
      subject,
      html,
    });
    if (DEBUG_AI) console.log(`📧 Email sent to ${to}: ${subject}`);
  }

  /**
   * Replace template variables in HTML content
   * @param html The HTML template
   * @param variables Variables to replace
   * @param noEscape Variables that should not be HTML-escaped (already contain HTML)
   */
  private replaceVariables(
    html: string,
    variables: Record<string, string>,
    noEscape: string[] = []
  ): string {
    let result = html;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      const replacementValue = noEscape.includes(key) ? value : this.escapeHtml(value);
      result = result.replace(regex, replacementValue);
    }
    return result;
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => map[char]);
  }

  /**
   * Format role for display (capitalize first letter)
   */
  private formatRole(role: string): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  /**
   * Format a date string for display
   */
  private formatDate(dateString: string): string {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  /**
   * Format expiration date for display
   */
  private formatExpirationDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  /**
   * Verify SMTP connection
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      if (DEBUG_AI) console.log('SMTP connection verified successfully');
      return true;
    } catch (error) {
      console.error('SMTP connection verification failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const emailService = new EmailService();
