import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import fetch from "node-fetch"; // Asegurate de tener node-fetch instalado si usas Node < 18

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
        
        // Filtramos por slug para que un negocio no vea los turnos de otro
        return rows
            .filter(row => row.get("slug") === slug)
            .map(row => ({
                turno: row.get("turno"), 
                phone: row.get("phone"),
                name: row.get("name"),
                semana: row.get("semana"),
                slug: row.get("slug"),
                estado: row.get("estado") // Traemos el estado por si lo necesitas en el front
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

        // 1. Formateo para la columna "turno" (Ej: 29/04 - 15:30)
        const [year, month, day] = data.fecha.split("-");
        const turnoFormateado = `${day}/${month} - ${data.hora}`;

        // 2. FECHA DE REGISTRO (Crucial para las Stats del Admin)
        const ahora = new Date();
        const fechaRegistro = ahora.toLocaleDateString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });

        // 3. GUARDAR EN EL SHEETS
        // Agregamos la columna "estado" para que el script de Google sepa qué hacer
        await sheet.addRow({
            name: data.name.trim(),
            phone: data.phone.toString().trim(),
            turno: turnoFormateado,
            semana: fechaRegistro,
            slug: data.slug,
            estado: "PENDIENTE" // <--- Esto es clave para que luego cambie a "ENVIADO"
        });

        // 4. DISPARAR NOTIFICACIÓN INMEDIATA (Apps Script)
        // Esto hace que el mail llegue al instante y no tengas que esperar al cron job
        if (process.env.APPS_SCRIPT_URL) {
            try {
                await fetch(process.env.APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: "newAppointmentEmail",
                        nombreCliente: data.name.trim(),
                        fechaHora: turnoFormateado,
                        adminEmail: "federicomartinezcontacto@gmail.com" // Podrías dynamicizar esto según el slug
                    })
                });
                
                // Opcional: Podrías volver a entrar al sheet y marcarlo como ENVIADO aquí mismo,
                // pero si el Apps Script ya lo hace con su propia función, no hace falta.
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
