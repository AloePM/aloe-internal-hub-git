"""
vendor_duplicate_check.py — Scans recent bills for possible duplicate vendor charges.
Called by the Hub's /vendor-duplicate-check route: python3 vendor_duplicate_check.py <days> <window_days>
Prints a single JSON object to stdout.
"""

import os
import sys
import json
import base64
import requests
from datetime import datetime, timedelta

RENTVINE_BASE = f"https://{os.getenv('RENTVINE_ACCOUNT', 'aloepm')}.rentvine.com/api/manager"
RENTVINE_AUTH = base64.b64encode(
    f"{os.getenv('RENTVINE_API_KEY', '')}:{os.getenv('RENTVINE_API_SECRET', '')}".encode()
).decode()

# Charge accounts treated as "expected recurring" — flagged separately, not as hard duplicates.
# Matches the categories already used in bo-tools.js's VENDOR_BILL_CATEGORIES.
RECURRING_CHARGE_ACCOUNT_IDS = {79, 83, 77}  # Landscaping, Pool Services, Pest Control

session = requests.Session()
session.headers.update({
    'Authorization': f'Basic {RENTVINE_AUTH}',
    'Accept': 'application/json',
})


def fetch_payables(date_min):
    """Paginate through Search Payables for bills posted on/after date_min."""
    all_rows = []
    page = 1
    while page <= 20:
        r = session.get(f"{RENTVINE_BASE}/accounting/payables/search", params={
            'page': page,
            'pageSize': 200,
            'datePostedMin': date_min,
            'isVoided': 'false',
        }, timeout=30)
        if not r.ok:
            raise Exception(f"Rentvine {r.status_code}: {r.text[:200]}")
        data = r.json()
        rows = data if isinstance(data, list) else data.get('data', [])
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < 200:
            break
        page += 1
    return all_rows


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    window_days = int(sys.argv[2]) if len(sys.argv) > 2 else 7

    date_min = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
    raw_rows = fetch_payables(date_min)

    bills = []
    for row in raw_rows:
        bill = row.get('bill', {})
        txn = row.get('transaction', {})
        contact = row.get('contact', {})
        prop = row.get('property') or {}
        try:
            amount = round(float(txn.get('amount', 0)), 2)
        except (TypeError, ValueError):
            amount = 0.0
        bills.append({
            'billID': bill.get('billID'),
            'vendor_id': contact.get('contactID'),
            'vendor_name': contact.get('name', ''),
            'property_id': prop.get('propertyID'),
            'property_address': prop.get('address', ''),
            'amount': amount,
            'date_posted': txn.get('datePosted', ''),
            'chargeAccountID': txn.get('chargeAccountID'),
            'voided': '1' if bill.get('isVoided') in (1, '1', True) else '0',
            'reference': bill.get('reference', ''),
        })

    # Group by (vendor, property)
    groups = {}
    for b in bills:
        key = (b['vendor_id'], b['property_id'])
        groups.setdefault(key, []).append(b)

    duplicates = []
    for key, group_bills in groups.items():
        group_bills.sort(key=lambda x: x['date_posted'] or '')
        for i in range(len(group_bills)):
            for j in range(i + 1, len(group_bills)):
                a, b = group_bills[i], group_bills[j]
                if a['billID'] == b['billID']:
                    continue
                if a['amount'] != b['amount'] or a['amount'] == 0:
                    continue
                try:
                    date_a = datetime.strptime(a['date_posted'][:10], '%Y-%m-%d')
                    date_b = datetime.strptime(b['date_posted'][:10], '%Y-%m-%d')
                except (ValueError, TypeError):
                    continue
                days_apart = abs((date_b - date_a).days)
                if days_apart > window_days:
                    continue
                is_recurring = a['chargeAccountID'] in RECURRING_CHARGE_ACCOUNT_IDS
                duplicates.append({
                    'bill_a': a,
                    'bill_b': b,
                    'vendor': a['vendor_name'],
                    'property': a['property_address'],
                    'amount': a['amount'],
                    'days_apart': days_apart,
                    'is_recurring_category': is_recurring,
                })

    print(json.dumps({
        'period_days': days,
        'window_days': window_days,
        'total_bills_scanned': len(bills),
        'duplicate_pairs_found': len(duplicates),
        'duplicates': duplicates,
    }))


if __name__ == '__main__':
    main()
