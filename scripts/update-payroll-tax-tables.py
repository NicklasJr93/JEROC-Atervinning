#!/usr/bin/env python3
"""Download official 2026 monthly tables 29–42 and extract fixed-amount rows.
Requires Python 3 and pdftotext. Never treats percentage rows as fixed amounts.
"""
import concurrent.futures, hashlib, json, pathlib, re, subprocess, tempfile, urllib.request
PAGE = 'https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/skattetabeller.4.96cca41179bad4b1aa8a46.html'
ROOT = pathlib.Path(__file__).resolve().parents[1]
page = urllib.request.urlopen(PAGE).read().decode()
urls = {}
for href, no in re.findall(r'href="([^"]*allmanna-tabeller-manad-tabell-(\d+)\.pdf)"', page):
    urls.setdefault(int(no), 'https://www.skatteverket.se' + href)
assert sorted(urls) == list(range(29, 43)), 'Official table list changed'
def extract(pair):
    no, url = pair
    raw = urllib.request.urlopen(url).read()
    with tempfile.TemporaryDirectory() as d:
        pdf = pathlib.Path(d) / 'table.pdf'; txt = pathlib.Path(d) / 'table.txt'
        pdf.write_bytes(raw)
        subprocess.run(['pdftotext', '-layout', str(pdf), str(txt)], check=True)
        text = txt.read_text()
    assert re.search(r'Skatteavdrag för månadslön 2026\s+Tabell ' + str(no), text), 'Wrong table/year'
    fixed = text.split('Preliminär skatt i %')[0]
    rows = []
    pattern = r'(\d+)\s*-\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)'
    for found in re.findall(pattern, fixed):
        row = list(map(int, found))
        if row[1] <= 80000: rows.append(row)
    rows.sort(key=lambda row: row[0])
    assert rows and rows[0][0] == 1 and rows[-1][1] == 80000
    assert all(a[1] + 1 == b[0] for a, b in zip(rows, rows[1:])), 'Missing/overlapping table rows'
    return no, {'url': url, 'sha256': hashlib.sha256(raw).hexdigest(), 'rows': rows}
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    tables = dict(sorted(pool.map(extract, urls.items())))
output = '// Generated from Skatteverket SKVFS 2025:20, checked 2026-10-23.\n// Fixed monthly amounts only: annual tax year 2026, monthly base up to SEK 80,000.\nexport const TAX_TABLES_2026 = Object.freeze(' + json.dumps(tables, ensure_ascii=False, separators=(',', ':')) + ');\n'
output += 'for (const table of Object.values(TAX_TABLES_2026)) { table.rows.forEach(Object.freeze); Object.freeze(table.rows); Object.freeze(table); }\n'
(ROOT / 'public/bokforing/suite/payroll-tax-tables-2026.js').write_text(output)
print('Extracted', sum(len(v['rows']) for v in tables.values()), 'rows from', len(tables), 'official tables')
