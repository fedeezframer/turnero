import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import fetch from "node-fetch";

const getAuth = () => new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n") : "",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

export async function getFullData(slug) {
    try {
        const auth = getAuth();
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        
        return rows
            .filter(row => row.get("slug") === slug)
            .map(row => ({
                turno: row.get("turno"), 
                phone: row.get("phone"),
                name: row.get("name"),
                email: row.get("email"), // 🔥 NUEVO
                reserva: row.get("reserva"),
                slug: row.get("slug"),
                estado: row.get("estado")
            }));
    } catch (e) {
        console.error("Error leyendo Sheets:", e.message);
        return [];
    }
}

export async function getOccupiedSlots(slug) {
    const data = await getFullData(slug);
    return data.map(d => d.turno).filter(Boolean);
}

export async function saveToSheets(data) {
    try {
        const auth = getAuth();
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        const [year, month, day] = data.fecha.split("-");
        const turnoFormateado = `${day}/${month} - ${data.hora}`;

        const ahora = new Date();
        const fechaRegistro = ahora.toLocaleDateString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });

        await sheet.addRow({
            name: data.name.trim(),
            phone: data.phone.toString().trim(),
            turno: turnoFormateado,
            reserva: fechaRegistro, // ✅ CLAVE
            slug: data.slug,
            estado: "PENDIENTE",
            email: data.email ? data.email.trim() : ""
        });

        if (process.env.APPS_SCRIPT_URL) {
            try {
                await fetch(process.env.APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: "newAppointmentEmail",
                        nombreCliente: data.name.trim(),
                        fechaHora: turnoFormateado,
                        adminEmail: "federicomartinezcontacto@gmail.com",
                        emailCliente: data.email // 🔥 CLAVE
                    })
                });
            } catch (fetchError) {
                console.error("Error al contactar Apps Script para el mail:", fetchError.message);
            }
        }

        return true;
    } catch (e) {
        console.error("Error guardando en Sheets:", e.message);
        return false;
    }
}
