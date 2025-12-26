import fs from 'fs';
import csvParser from 'csv-parser';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.COCKROACHDB_URL,
  ssl: { rejectUnauthorized: false },
});

async function importNotes(filePath) {
  const notes = [];
  fs.createReadStream(filePath)
    .pipe(csvParser())
    .on('data', (row) => notes.push(row))
    .on('end', async () => {
      for (const note of notes) {
        await pool.query(
          `INSERT INTO notes (title, content, emoji, category, slug, public, session_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            note.title,
            note.content,
            note.emoji,
            note.category || 'today',
            note.slug,
            note.public === 'true',
            note.session_id || null,
            note.created_at || new Date(),
          ]
        );
      }
      console.log(`Imported ${notes.length} notes`);
      await pool.end();
    });
}

importNotes('notes.csv');
