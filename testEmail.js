// testEmail.js
require("dotenv").config();
const sg = require("@sendgrid/mail");
sg.setApiKey(process.env.SENDGRID_API_KEY);

(async () => {
  try {
    await sg.send({
      to: "tuemailpersonal@gmail.com", // prueba real
      from: process.env.EMAIL_FROM,
      subject: "✅ Test NightVibe - SendGrid funcionando",
      html: "<h1>¡Funciona!</h1><p>Tu dominio NightVibe ya puede enviar entradas por correo.</p>",
    });
    console.log("📧 Email enviado correctamente");
  } catch (err) {
    console.error("❌ Error al enviar email:", err.response?.body || err.message);
  }
})();
