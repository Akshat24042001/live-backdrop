// The speaker list: who is on stage, with their photo. Stored in data/speakers.json, photos in public/assets/speakers/.
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export function createSpeakers({ dataDir, photoDir, log }) {
  const file = path.join(dataDir, 'speakers.json');
  fs.mkdirSync(photoDir, { recursive: true });
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch {}
  // Temp file then rename, so a power cut mid-save cannot leave a half-written speaker list.
  const save = () => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2)); fs.renameSync(file + '.tmp', file); } catch (e) { log({ ev: 'speakers_save_error', msg: e.message }); } };
  const clean = (v, n = 300) => String(v ?? '').trim().slice(0, n);

  return {
    all: () => list,
    get: (id) => list.find((s) => s.id === id),

    upsert(input) {
      const id = clean(input.id, 40) || `sp${Date.now().toString(36)}`;
      const s = list.find((x) => x.id === id) || { id };
      Object.assign(s, {
        // A field left out keeps its old value, so a partial save (e.g. only a new photo) loses nothing.
        name: clean(input.name ?? s.name, 120),
        role: clean(input.role ?? s.role, 160),
        topic: clean(input.topic ?? s.topic, 300),
        terms: clean(input.terms ?? s.terms, 1000),
        about: clean(input.about ?? s.about, 1500), // background for the AI: company, causes, style. Never shown on screen.
        photo: clean(input.photo ?? s.photo, 300),
      });
      if (!list.includes(s)) list.push(s);
      save();
      return s;
    },

    remove(id) {
      const gone = list.find((s) => s.id === id);
      list = list.filter((s) => s.id !== id);
      save();
      // Delete the photo file too, unless another speaker still uses it.
      const photo = gone?.photo;
      if (photo?.startsWith('/assets/speakers/') && !list.some((s) => s.photo === photo)) {
        fs.rm(path.join(photoDir, path.basename(photo)), { force: true }, () => {});
      }
    },

    move(id, dir) {
      const i = list.findIndex((s) => s.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      save();
    },

    // Photos come from the operator's computer. Turn them upright, shrink them for the LED, save as JPEG.
    async savePhoto(buffer) {
      const name = `photo-${Date.now().toString(36)}.jpg`;
      await sharp(buffer).rotate().resize({ width: 1000, height: 1250, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(path.join(photoDir, name));
      return `/assets/speakers/${name}`;
    },
  };
}
