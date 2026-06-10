"""
One-time import script: direct_customers.csv → Supabase wa_direct_customers table
Usage: python import_direct_customers.py

Set these environment variables before running:
  SUPABASE_URL=https://your-project.supabase.co
  SUPABASE_KEY=your-supabase-service-key
"""

import os, csv, json, urllib.request, urllib.error

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
CSV_FILE     = r'C:\Tech\YFBLandingPortal\direct_customers.csv'
BATCH_SIZE   = 100

if not SUPABASE_URL or not SUPABASE_KEY:
    print('ERROR: Set SUPABASE_URL and SUPABASE_KEY environment variables first.')
    print('  set SUPABASE_URL=https://xxxx.supabase.co')
    print('  set SUPABASE_KEY=your-service-role-key')
    exit(1)

# Read and deduplicate by phone
seen_phones = set()
rows = []
with open(CSV_FILE, encoding='utf-8-sig') as f:
    reader = csv.reader(f)
    next(reader)  # skip header
    for parts in reader:
        if len(parts) < 2:
            continue
        name  = parts[0].strip()
        phone = parts[-1].strip().replace(' ', '').replace('+', '').replace('-', '')
        if not phone.isdigit():
            continue
        # Normalise to 91XXXXXXXXXX
        if len(phone) == 10:
            phone = '91' + phone
        if phone not in seen_phones:
            seen_phones.add(phone)
            rows.append({'name': name, 'phone': phone})

print(f'Unique customers to import: {len(rows)}')

# Upsert in batches
endpoint = f'{SUPABASE_URL}/rest/v1/wa_direct_customers'
headers  = {
    'apikey':        SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type':  'application/json',
    'Prefer':        'resolution=merge-duplicates'
}

total_sent = 0
for i in range(0, len(rows), BATCH_SIZE):
    batch = rows[i:i+BATCH_SIZE]
    data  = json.dumps(batch).encode('utf-8')
    req   = urllib.request.Request(endpoint, data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req) as resp:
            total_sent += len(batch)
            print(f'  Imported {total_sent}/{len(rows)}...', end='\r')
    except urllib.error.HTTPError as e:
        print(f'\nERROR at batch {i}: {e.code} {e.read().decode()}')
        break

print(f'\nDone! {total_sent} customers imported to wa_direct_customers.')
