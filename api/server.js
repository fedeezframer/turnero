import express from "express";
import cors from "cors";
import { saveToSheets, getOccupiedSlots } from "./sheets.js";
import nodemailer from "nodemailer";

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// CONFIGURACIÓN DE CORREO REFORZADA
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465, // Puerto SSL (más seguro para Render)
    secure: true, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS, // DEBE SER CONTRASEÑA DE APLICACIÓN
    },
    tls: {
        rejectUnauthorized: false
    }
});

app.get("/check-availability", async (req, res) => {
    try {
        const ocupados = await getOccupiedSlots();
        res.json({ ocupados });
    } catch (e) {
        res.status(500).json({ error: "Error al consultar disponibilidad" });
    }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body;
        const turnoString = `${fecha} - ${hora}`;

        // 1. Guardar en Sheets (Ya confirmaste que esto funciona)
        const success = await saveToSheets({ 
            name: name || "Sin nombre", 
            phone: phone || "N/A", 
            email: email || "N/A", 
            turno: turnoString 
        });

        if (success) {
            // 2. Intentar mandar el mail
            try {
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: process.env.EMAIL_USER, // Te llega a vos
                    subject: `📌 NUEVO TURNO: ${name}`,
                    text: `Nuevo turno agendado:\n\nCliente: ${name}\nFecha/Hora: ${turnoString}\nTeléfono: ${phone}\nEmail: ${email || "N/A"}`
                });
                console.log("Mail enviado con éxito");
            } catch (mailError) {
                // Si el mail falla, logueamos el error exacto en Render pero no cortamos el proceso
                console.error("ERROR DETALLADO DE MAIL:", mailError);
            }

            res.json({ status: "success", message: "Reserva confirmada" });
        } else {
            throw new Error("Error al guardar en Sheets");
        }
    } catch (e) {
        console.error("Error en el servidor:", e);
        res.status(500).json({ status: "error", error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 API activa en puerto ${PORT}`);
});
