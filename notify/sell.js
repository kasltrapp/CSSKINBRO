import { Resend } from 'resend';

const resend = new Resend(process.env.re_YiQSLm2s_FCQxGbt4a8aKhZrACDz1ZMEL);

export async function handleSellNotification(submission) {
  await resend.emails.send({
    from: 'KASTLR <noreply@kastlr.com>',
    to: 'alerts@kastlr.com',
    subject: `New Sell Submission — ${submission.reference}`,
    html: `
      <h2>New Sell Submission</h2>
      <p><strong>Reference:</strong> ${submission.reference}</p>
      <p><strong>Name:</strong> ${submission.name}</p>
      <p><strong>Email:</strong> ${submission.email}</p>
      <p><strong>Phone:</strong> ${submission.phone || '—'}</p>
      <p><strong>Real Value:</strong> R${submission.real_value_zar?.toLocaleString('en-ZA')}</p>
      <p><strong>Offer (75%):</strong> R${submission.offer_zar?.toLocaleString('en-ZA')}</p>
      <p><strong>Items:</strong> ${submission.item_count}</p>
      <p><strong>Steam URL:</strong> ${submission.steam_url}</p>
      <p><strong>Message:</strong> ${submission.message || '—'}</p>
      <hr/>
      <p><a href="https://kastlr.com/c9-ty7lipzig46/">View in Admin Panel</a></p>
    `
  });
}
