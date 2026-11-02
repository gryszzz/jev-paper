'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const ROW_ID = process.env.JEV_STATE_ID || 'default';

function fileLoad() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[store] file load', e.message);
  }
  return null;
}

function fileSave(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (e) {
    console.warn('[store] file save', e.message);
  }
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadState() {
  const sb = supabaseClient();
  if (sb) {
    try {
      const { data, error } = await sb.from('jev_paper_state').select('state').eq('id', ROW_ID).maybeSingle();
      if (error) throw error;
      if (data && data.state && data.state.version) {
        console.log('[store] loaded from supabase');
        fileSave(data.state); // mirror locally
        return data.state;
      }
    } catch (e) {
      console.warn('[store] supabase load', e.message || e);
    }
  }
  return fileLoad();
}

let _saveTimer = null;
let _pending = null;

function saveState(state, { immediate = false } = {}) {
  _pending = state;
  fileSave(state);
  const flush = async () => {
    const s = _pending;
    _pending = null;
    const sb = supabaseClient();
    if (!sb || !s) return;
    try {
      const { error } = await sb.from('jev_paper_state').upsert({
        id: ROW_ID,
        state: s,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    } catch (e) {
      console.warn('[store] supabase save', e.message || e);
    }
  };
  if (immediate) return flush();
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flush();
  }, 1500);
  return Promise.resolve();
}

module.exports = { loadState, saveState, fileLoad, fileSave };
