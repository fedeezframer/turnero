import { MercadoPagoConfig, Preference } from "mercadopago";
export async function createPreference(req, res) {
    try {
        const { nombre, telefono, email, fecha, hora, slug } = req.body;
        const { data: user } = await supabase
            .from("usuarios")
            .select("*")
            .eq("slug", slug)
            .single();
        if (!user) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }
        const metodo = user.metodo_pago;
        const tieneMP = !!user.mp_access_token;
        const debePagar = tieneMP && (metodo === "sena" || metodo === "total");
        if (!debePagar) {
            return res.json({ isFree: true });
        }
        const client = new MercadoPagoConfig({ 
            accessToken: user.mp_access_token
        });
        const preference = new Preference(client);
        const response = await preference.create({
            body: {
                items: [
                    {
                        title: `Reserva: ${fecha} a las ${hora}hs`,
                        unit_price: Number(user.monto_sena || user.precio || 5000),
                        quantity: 1,
                        currency_id: "ARS"
                    }
                ],
                metadata: {
                    nombre,
                    telefono,
                    email,
                    fecha,
                    hora,
                    slug
                },
                notification_url: "https://framerturnero.onrender.com/webhook",
                back_urls: {
                    success: "https://negosocio.framer.website/success",
                    failure: "https://negosocio.framer.website/error",
                    pending: "https://negosocio.framer.website/error"
                },
                auto_return: "approved",
            },
        });
        res.json({ payment_url: response.init_point });
    } catch (error) {
        console.error("Error al crear preferencia:", error);
        res.status(500).json({ error: error.message });
    }
}
