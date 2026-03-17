import express from "express";
import cors from "cors";
import { saveToSheets, getOccupiedSlots } from "./sheets.js";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de Mail (Usando Gmail como ejemplo, podés usar Resend/Sendgrid)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS, // App Password de Google
    }
});

// 1. RUTA DE CONSULTA (Para que los botones de Framer se bloqueen)
app.get("/check-availability", async (req, res) => {
    try {
        const ocupados = await getOccupiedSlots();
        res.json({ ocupados });
    } catch (e) {
        res.status(500).json({ error: "Error al consultar disponibilidad" });
    }
});

// 2. RUTA DE RESERVA
app.post("/create-booking", async (req, res) => {
    try {
        const { name, last_name, phone, email, fecha, hora } = req.body;
        const turnoString = `${fecha} - ${hora}`;

        // Validamos disponibilidad real
        const ocupados = await getOccupiedSlots();
        if (ocupados.includes(turnoString)) {
            return res.status(400).json({ success: false, message: "Turno ya ocupado" });
        }

        // Guardamos en la hoja
        const success = await saveToSheets({ 
            name, 
            last_name, 
            phone, 
            email, 
            turno: turnoString 
        });

        if (success) {
            // Enviar Mail de notificación
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER, // Te llega a vos mismo
                subject: `📌 Nuevo Turno: ${name} ${last_name}`,
                text: `Nuevo turno agendado:\n\nCliente: ${name} ${last_name}\nFecha/Hora: ${turnoString}\nTeléfono: ${phone}\nEmail: ${email}`
            };
            await transporter.sendMail(mailOptions);

            res.json({ success: true, message: "Reserva confirmada" });
        } else {
            throw new Error("Error al guardar en Sheets");
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API de Turnos activa en puerto ${PORT}`));
