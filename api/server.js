import express from "express";
import cors from "cors";
import { saveToSheets, getOccupiedSlots } from "./sheets.js";
import nodemailer from "nodemailer";

const app = express();

// Configuración de CORS abierta para evitar bloqueos desde Framer
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// CONFIGURACIÓN DE CORREO (Corregida para evitar ETIMEDOUT)
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465, 
    secure: true, // true para puerto 465
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false // Ayuda a conectar desde servidores externos como Render
    },
    connectionTimeout: 10000, // 10 segundos de espera
});

// 1. RUTA DE CONSULTA (Para bloquear turnos en Framer)
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
        const { name, phone, email, fecha, hora } = req.body;
        const turnoString = `${fecha} - ${hora}`;

        // Verificar disponibilidad de último momento
        const ocupados = await getOccupiedSlots();
        if (ocupados.includes(turnoString)) {
            return res.status(400).json({ status: "error", message: "Este turno se acaba de ocupar." });
        }

        // Guardar en Google Sheets
        const success = await saveToSheets({ 
            name: name || "Sin nombre", 
            phone: phone || "N/A", 
            email: email || "N/A", 
            turno: turnoString 
        });

        if (success) {
            // Enviamos el mail (usamos try/catch para que si falla el mail, no se cancele la reserva)
            try {
                const mailOptions = {
                    from: process.env.EMAIL_USER,
                    to: process.env.EMAIL_USER,
                    subject: `📌 Nuevo Turno: ${name}`,
                    text: `Nuevo turno agendado:\n\nCliente: ${name}\nFecha/Hora: ${turnoString}\nTeléfono: ${phone}\nEmail: ${email}`
                };
                await transporter.sendMail(mailOptions);
            } catch (mailError) {
                console.error("Error enviando mail (pero la reserva se guardó):", mailError.message);
            }

            res.json({ status: "success", message: "Reserva confirmada" });
        } else {
            throw new Error("No se pudo guardar en la planilla de Google.");
        }
    } catch (e) {
        console.error("Error en el servidor:", e);
        res.status(500).json({ status: "error", error: e.message });
    }
});

// ESCUCHA DE PUERTO (Unificado)
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor funcionando en puerto ${PORT}`);
});
