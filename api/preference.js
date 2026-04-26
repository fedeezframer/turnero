import Stripe from "stripe";
import { MercadoPagoConfig, Preference } from "mercadopago";

export async function createPreference(req, res) {
    try {
        const { nombre, telefono, email, fecha, hora, slug, servicio_id } = req.body;

        const { data: user, error: userError } = await supabase
            .from("usuarios")
            .select("*")
            .eq("slug", slug)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        // --- Obtener servicio si se pasó un servicio_id ---
        let precioFinal = Number(user.precio || 5000);
        let nombreServicio = "Reserva";

        if (servicio_id) {
            const { data: servicio, error: servicioError } = await supabase
                .from("servicios")
                .select("*")
                .eq("id", servicio_id)
                .single();

            if (!servicioError && servicio) {
                precioFinal = Number(servicio.precio || precioFinal);
                nombreServicio = servicio.nombre || nombreServicio;
            }
        }

        // Si metodo_pago es sena, usamos monto_sena
        if (user.metodo_pago === "sena" && user.monto_sena) {
            precioFinal = Number(user.monto_sena);
        }

        const metodo = user.metodo_pago || "none";
        const tieneMP = !!user.mp_access_token;
        const tieneStripe = !!user.stripe_secret_key;
        const debePagar = metodo === "sena" || metodo === "total";

        if (!debePagar) {
            return res.json({ isFree: true });
        }

        // --- FLUJO STRIPE ---
        if (tieneStripe) {
            const stripe = new Stripe(user.stripe_secret_key);

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ["card"],
                line_items: [
                    {
                        price_data: {
                            currency: "ars",
                            product_data: {
                                name: `${nombreServicio}: ${fecha} a las ${hora}hs`,
                            },
                            unit_amount: Math.round(precioFinal * 100), // Stripe usa centavos
                        },
                        quantity: 1,
                    },
                ],
                mode: "payment",
                metadata: {
                    nombre,
                    telefono,
                    email: email || "",
                    fecha,
                    hora,
                    slug,
                    servicio_id: servicio_id || "",
                    metodo_pago: metodo,
                },
                success_url: "https://negosocio.framer.website/success",
                cancel_url: "https://negosocio.framer.website/error",
            });

            return res.json({ payment_url: session.url });
        }

        // --- FLUJO MERCADO PAGO ---
        if (tieneMP) {
            const client = new MercadoPagoConfig({
                accessToken: user.mp_access_token,
            });

            const preference = new Preference(client);

            const response = await preference.create({
                body: {
                    items: [
                        {
                            title: `${nombreServicio}: ${fecha} a las ${hora}hs`,
                            unit_price: precioFinal,
                            quantity: 1,
                            currency_id: "ARS",
                        },
                    ],
                    metadata: {
                        nombre,
                        telefono,
                        email: email || "",
                        fecha,
                        hora,
                        slug,
                        servicio_id: servicio_id || "",
                        tipo_pago: metodo,
                    },
                    notification_url: "https://framerturnero.onrender.com/webhook",
                    back_urls: {
                        success: "https://negosocio.framer.website/success",
                        failure: "https://negosocio.framer.website/error",
                        pending: "https://negosocio.framer.website/error",
                    },
                    auto_return: "approved",
                },
            });

            return res.json({ payment_url: response.init_point });
        }

        // --- Sin método de pago configurado ---
        return res.status(400).json({
            error: "Este negocio no tiene configurado ningún método de pago.",
        });

    } catch (error) {
        console.error("Error al crear preferencia:", error);
        res.status(500).json({ error: error.message });
    }
}
