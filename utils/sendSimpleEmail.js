// utils/sendSimpleEmail.js
const sg = require('@sendgrid/mail');

module.exports = async function sendSimpleEmail({ to, subject, html }) {
  const key = process.env.SENDGRID_API_KEY;
  const from = process.env.SENDGRID_FROM; // p.ej. tickets@nightvibe.life
  if (!key || !from) throw new Error('Faltan SENDGRID_API_KEY / SENDGRID_FROM');
  sg.setApiKey(key);
  await sg.send({ to, from, subject, html });
};
