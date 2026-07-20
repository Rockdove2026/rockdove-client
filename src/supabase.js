import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// L3 (audit): missing env vars made createClient throw at module load — a blank
// page with no diagnosis. Fail loudly in the console instead.
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Rock Dove: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — check Vercel env configuration.");
}
export const supabase = createClient(SUPABASE_URL || "https://invalid.supabase.co", SUPABASE_ANON_KEY || "missing");
