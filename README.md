# Kasboek — installeerbare app

Kasboek als eigen app: op je iPhone/iPad en Windows-pc te installeren, werkt offline, en synchroniseert je gegevens via je eigen (gratis) Supabase-account. Alles staat in deze map; er is geen build-stap nodig.

De app is een *Progressive Web App* (PWA). Je zet hem één keer online (GitHub Pages, Netlify of Vercel) en installeert hem daarna vanuit de browser als app met eigen icoon.

## Inhoud van deze map

| Bestand | Wat het is |
|---|---|
| `index.html`, `app.js`, `app.css` | De app zelf (dezelfde functies als de Kasboek-pagina in Claude) |
| `config.js` | **Hier vul je je Supabase-gegevens in** (stap 1) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Maken er een installeerbare, offline werkende app van |
| `seed.json` | Je startgegevens (6 rekeningen, 30 vaste lasten, augustus 2026) — laad je één keer via Instellingen |
| `supabase/schema.sql` | Database-inrichting voor Supabase (stap 1) |
| `vendor/` | De Supabase-bibliotheek, lokaal meegeleverd zodat de app offline opent |
| `src/` | Bronbestanden voor als je (of Claude) de app later wilt aanpassen; niet nodig voor gebruik |

## Stap 1 — Supabase inrichten (± 5 minuten, gratis)

1. Ga naar https://supabase.com, maak een account en klik op **New project**. Kies een naam (bijv. `kasboek`), een sterk database-wachtwoord (bewaar dat ergens; je hebt het verder niet nodig) en regio **West EU (Ireland)** of **Central EU (Frankfurt)**.
2. Wacht tot het project klaar is. Ga naar **SQL Editor** (linkermenu) → **New query**, plak de volledige inhoud van `supabase/schema.sql` en klik **Run**. Je ziet "Success. No rows returned".
3. Ga naar **Authentication → Providers → Email**. Zet **Confirm email** *uit* (anders moet je eerst een bevestigingsmail afhandelen). Laat de rest staan.
4. Ga naar **Project Settings → API** (tandwiel-icoon). Kopieer:
   - **Project URL** (ziet eruit als `https://abcdefgh.supabase.co`)
   - **anon public** key (lange tekst die begint met `eyJ…`)
5. Open `config.js` in een teksteditor en vul beide waarden in:
   ```js
   window.KASBOEK_CONFIG = {
     supabaseUrl: "https://abcdefgh.supabase.co",
     supabaseAnonKey: "eyJhbGciOi…",
   };
   ```
   De anon-sleutel mag in de app staan: hij geeft alleen toegang tot rijen van de ingelogde gebruiker (dat regelt het script uit stap 2).

## Stap 2 — Online zetten

Kies één van de drie. Gebruik altijd de **hele map** (inclusief `icons/` en `vendor/`).

**GitHub Pages**
1. Maak op github.com een nieuwe *private* repository, bijv. `kasboek`.
2. Upload alle bestanden uit deze map (Add file → Upload files) en commit.
3. Settings → Pages → Source: *Deploy from a branch*, branch `main`, map `/ (root)` → Save.
4. Na een minuut staat de app op `https://<jouw-gebruikersnaam>.github.io/kasboek/`.

**Netlify**
1. Log in op netlify.com → *Add new site* → *Deploy manually* en sleep deze map het venster in. Klaar; je krijgt een adres als `https://xyz.netlify.app`.
2. (Optioneel) Site settings → Change site name voor een leesbaar adres.

**Vercel**
1. Zet de map in een GitHub-repository (zie hierboven) en importeer die op vercel.com → *Add New Project*. Framework: *Other*. Deploy.

Nieuwe versie plaatsen? Overschrijf de bestanden. De app merkt het zelf en toont "Er is een nieuwe versie — Vernieuwen".

## Stap 3 — Eerste keer openen

1. Open het adres in je browser. Je ziet het inlogscherm.
2. Vul je e-mailadres en een wachtwoord in en klik **Account aanmaken**. Je bent direct ingelogd.
3. Ga naar **Instellingen** en klik **Startgegevens laden**: je 6 rekeningen, vaste lasten en augustus 2026 worden ingelezen (stand van 3 september 2026). Daarna gebruik je de app precies zoals de pagina in Claude.
4. **Aanbevolen**: ga in Supabase naar **Authentication → Providers → Email** en zet **Allow new users to sign up** *uit*. Dan kan niemand anders een account maken op jouw database. Jij logt gewoon in met je bestaande account.

## Stap 4 — Installeren als app

**iPhone / iPad (Safari)**: open het adres → deel-knop (vierkant met pijl) → **Zet op beginscherm** → Voeg toe. Kasboek staat nu als app tussen je andere apps, opent zonder browserbalk en werkt ook offline (wijzigingen offline worden gesynchroniseerd zodra je weer online bent).

**Windows (Edge of Chrome)**: open het adres → klik het *installeer*-icoon rechts in de adresbalk (of menu ⋯ → **Apps → Deze site installeren als app**). Kasboek komt in het Startmenu en kan aan de taakbalk.

**Mac (Safari)**: Archief → *Voeg toe aan Dock*. **Android (Chrome)**: menu ⋮ → *Toevoegen aan startscherm*.

Op elk apparaat log je in met hetzelfde account; alles wat je op de een doet, zie je op de ander.

## Dagelijks gebruik

Werkt hetzelfde als de Kasboek-pagina in Claude: *Maand* met Begin / Nu (geschat) / Einde per rekening, posten bevestigen of overslaan, *+ Toevoegen*, *Beginsaldo's* vastzetten, *Prognose*, *Vaste lasten*, en de tabs *Leningen*, *Woning*, *Beleggingen* en *Overig* met de vermogensbalk.

Extra in de app (onder Instellingen): synchronisatiestatus, *Nu synchroniseren*, wachtwoord wijzigen, uitloggen, en **Exporteren / Importeren** van een JSON-back-up. Maak af en toe een export; dat bestand kun je altijd weer inladen.

## Als iets niet werkt

- **"Nog niet gekoppeld aan Supabase"** bovenin: `config.js` is niet (goed) ingevuld. De app werkt dan wel, maar bewaart alles alleen op dit apparaat.
- **"Geen verbinding met Supabase"** bij inloggen: controleer de Project URL in `config.js` en of je internet hebt.
- **"Onjuist e-mailadres of wachtwoord"**: gebruik *Wachtwoord vergeten?* — je krijgt een mail met een link; na klikken vraagt de app om een nieuw wachtwoord.
- **Oranje bolletje "wijzigingen wachten"**: je wijzigingen staan lokaal klaar en gaan mee zodra de verbinding er is. Klik eventueel *Nu synchroniseren*.
- **Alles opnieuw beginnen**: Instellingen → Exporteren (voor de zekerheid), dan in Supabase *Table Editor → kasboek_docs* de rijen verwijderen en de startgegevens opnieuw laden.

## Voor later: iets aanpassen

Vraag Claude in het project *Personal finance* om een wijziging; daar staan de bronbestanden en de bouwstappen. Je krijgt dan een nieuwe map die je online overschrijft — de app meldt zelf dat er een nieuwe versie is.
