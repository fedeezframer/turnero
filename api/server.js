import express from "express";
import cors from "cors";
import { saveToSheets, getOccupiedSlots } from "./sheets.js";
import nodemailer from "nodemailer";

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    }
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

        const ocupados = await getOccupiedSlots();
        if (ocupados.includes(turnoString)) {
            return res.status(400).json({ status: "error", message: "Turno ya ocupado" });
        }

        // IMPORTANTE: Aquí mapeamos lo que llega de Framer a lo que espera Sheets
        const success = await saveToSheets({ 
            name: name, 
            phone: phone, 
            email: email, 
            turno: turnoString 
        });

        if (success) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER,
                subject: `📌 Nuevo Turno: ${name}`,
                text: `Nuevo turno agendado:\n\nCliente: ${name}\nFecha/Hora: ${turnoString}\nTeléfono: ${phone}\nEmail: ${email}`
            };
            await transporter.sendMail(mailOptions);

            res.json({ status: "success", message: "Reserva confirmada" });
        } else {
            throw new Error("Error al guardar en Sheets");
        }
    } catch (e) {
        console.error("Error en el servidor:", e);
        res.status(500).json({ status: "error", error: e.message });
    }
});

// CORRECCIÓN: Un solo listen al final
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 API activa en puerto ${PORT}`);
});
