import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

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
                slug: row.get("slug")
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

        // 1. Formateo para la columna "turno" (Ej: 29/03 - 15:30)
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
        // Agregamos "slug" para identificar de quién es el turno
        await sheet.addRow({
            name: data.name.trim(),
            phone: data.phone.toString().trim(),
            turno: turnoFormateado,
            semana: fechaRegistro,
            slug: data.slug // <--- NO OLVIDAR ESTO
        });

        return true;
    } catch (e) {
        console.error("Error guardando en Sheets:", e.message);
        return false;
    }
}
