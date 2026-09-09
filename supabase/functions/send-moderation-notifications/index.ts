import { createClient } from "@supabase/supabase-js";
import { runNotificationCycle } from "../../../src/lib/utils/moderation-notification-send.ts";

Deno.serve(async (req) => {
  const suppliedSecret = req.headers.get("x-notification-secret");
  const expectedSecret = Deno.env.get("NOTIFICATION_FUNCTION_SECRET");
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { mode } = await req.json();
  if (mode !== "urgent" && mode !== "digest") {
    return new Response("Invalid mode", { status: 400 });
  }

  const client = createClient(
    // SUPABASE_URL/SUPABASE_ANON_KEY are reserved names Supabase's Edge
    // Runtime auto-injects (both locally and when deployed) — distinct
    // from this project's own PUBLIC_SUPABASE_URL/PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    // which are just this app's Vite/Astro naming convention and were
    // never going to be set here.
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { error: signInError } = await client.auth.signInWithPassword({
    email: Deno.env.get("NOTIFICATION_AGENT_EMAIL")!,
    password: Deno.env.get("NOTIFICATION_AGENT_PASSWORD")!,
  });
  if (signInError) {
    console.error("Failed to sign in notification agent:", signInError.message);
    return new Response("Internal error", { status: 500 });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
  const resendFrom = Deno.env.get("RESEND_FROM_EMAIL")!;

  try {
    const result = await runNotificationCycle(
      client,
      mode,
      new Date(),
      async ({ subject, html, to }) => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: resendFrom, to, subject, html }),
        });
        if (!response.ok) {
          console.error("Resend send failed:", await response.text());
          return false;
        }
        return true;
      },
    );

    return new Response(JSON.stringify(result), { status: 200 });
  } catch (err) {
    console.error("Notification cycle failed:", err);
    return new Response("Internal error", { status: 500 });
  }
});
