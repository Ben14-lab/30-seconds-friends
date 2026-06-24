import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    "Supabase env variables ontbreken. Vul VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY in via een .env bestand (zie .env.example)."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
