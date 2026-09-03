import { defineMiddleware } from "astro:middleware";
import { createServerSupabaseClient } from "./lib/supabase/server";

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = null;
  context.locals.supabase = null;

  if (!context.url.pathname.startsWith("/admin")) {
    return next();
  }

  const supabase = createServerSupabaseClient(context.request, context.cookies);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  context.locals.user = user;
  context.locals.supabase = supabase;

  if (context.url.pathname !== "/admin/login" && !user) {
    return context.redirect("/admin/login");
  }

  return next();
});
