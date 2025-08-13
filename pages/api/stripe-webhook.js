import Stripe from 'stripe';

export const config = {
  api: { bodyParser: false }, // Stripe требует "сырой" body для проверки подписи
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  const sig = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Достаём email / name
  let email = null;
  let name = null;

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    email = session?.customer_details?.email || session?.customer_email || null;
    name  = session?.customer_details?.name || null;
  } else if (event.type === 'payment_intent.succeeded') {
    const pi = await stripe.paymentIntents.retrieve(event.data.object.id, {
      expand: ['customer', 'charges.data.billing_details'],
    });
    email = (pi.customer && typeof pi.customer === 'object' && pi.customer.email)
         || pi.receipt_email
         || pi.charges?.data?.[0]?.billing_details?.email
         || null;
    name  = (pi.customer && typeof pi.customer === 'object' && pi.customer.name)
         || pi.charges?.data?.[0]?.billing_details?.name
         || null;
  } else {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  if (!email) {
    console.warn('No email in event, skipping:', event.type);
    return res.status(200).json({ received: true, skipped: 'no_email' });
  }

  const mlResp = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MAILERLITE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      fields: { name: name || undefined },
      groups: [process.env.MAILERLITE_GROUP_ID]
    }),
  });

  if (!mlResp.ok) {
    const text = await mlResp.text();
    console.error('MailerLite error:', mlResp.status, text);
    return res.status(200).json({ received: true, mailerlite_error: mlResp.status });
  }

  return res.status(200).json({ received: true, synced: true });
}
