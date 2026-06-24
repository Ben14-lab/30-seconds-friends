# 30 Seconds — Online (zelf hosten)

Een online versie van het partyspel "30 Seconds". Werkt met room-codes: iedereen
die de link met dezelfde code opent, komt in dezelfde sessie terecht. Wie aan
de beurt is om uit te leggen ziet de 5 woorden; de rest ziet alleen de timer en
de live score.

## 1. Supabase opzetten (gratis)

1. Maak een gratis account op https://supabase.com en maak een nieuw project aan.
2. Ga naar **SQL Editor** → **New query**, plak de inhoud van `supabase.sql` uit
   deze map, en klik op **Run**. Dit maakt de tabel `game_rooms` aan en zet
   Realtime aan.
3. Ga naar **Project Settings → API**. Kopieer:
   - **Project URL**
   - **anon public key**

## 2. Lokaal testen

```bash
cp .env.example .env
# vul .env aan met je Project URL en anon key
npm install
npm run dev
```

Open de getoonde localhost-link, maak een room aan, en test het spel (open de
link in een tweede tabblad/telefoon om de online sync te zien).

## 3. Live hosten (gratis, via Vercel)

1. Zet deze map in een eigen GitHub-repository (`git init`, commit, push).
2. Ga naar https://vercel.com → **Add New Project** → importeer je repository.
3. Bij **Environment Variables** voeg je toe:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Klik op **Deploy**. Je krijgt een eigen link (bijv. `30-seconds-jij.vercel.app`).

Netlify werkt op vergelijkbare manier: importeer de repo, zet build command op
`npm run build`, publish directory op `dist`, en voeg dezelfde environment
variables toe.

## Hoe vrienden meedoen

- Iemand maakt een room aan (de URL krijgt automatisch `?room=AB3K` erbij) en
  deelt die link.
- Vrienden openen de link, vullen hun naam in, en kiezen een team.
- Het hele spel — lobby, beurten, score — synct automatisch tussen alle
  geopende schermen.

## Let op: geen wachtwoord per room

Voor de eenvoud zijn de databaserechten zo ingesteld dat iedereen met de
(geraden of gedeelde) roomcode kan meelezen en meeschrijven. Voor een casual
spel met vrienden is dat geen probleem, maar het is geen beveiligde omgeving —
zet er dus geen gevoelige data in.

## Projectstructuur

```
.
├── index.html
├── package.json
├── vite.config.js
├── supabase.sql          ← eenmalig uitvoeren in Supabase
├── .env.example
└── src/
    ├── main.jsx
    ├── App.jsx           ← alle spellogica en schermen
    ├── supabaseClient.js
    └── index.css
```
