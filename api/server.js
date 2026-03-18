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

// CONFIGURACIÓN DE CORREO REFORZADA (Puerto 587 con STARTTLS)
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // false para usar STARTTLS
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false
    },
    connectionTimeout: 20000, // 20 segundos
    socketTimeout: 20000
});

// 1. RUTA DE CONSULTA
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

        // Guardar en Google Sheets (Esto ya funciona)
        const success = await saveToSheets({ 
            name: name || "Sin nombre", 
            phone: phone || "N/A", 
            email: email || "N/A", 
            turno: turnoString 
        });

        if (success) {
            // ENVIAR AVISO (Si falla el mail, no rompemos la respuesta)
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER,
                subject: `📌 NUEVO TURNO: ${name}`,
                text: `¡Hola! Tenés un nuevo turno:\n\nCliente: ${name}\nFecha/Hora: ${turnoString}\nTeléfono: ${phone}\nEmail: ${email || "No cargado"}`
            }).then(() => console.log("✅ Mail enviado correctamente"))
              .catch(err => console.error("❌ Falló el mail pero se guardó en Sheets:", err.message));

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
