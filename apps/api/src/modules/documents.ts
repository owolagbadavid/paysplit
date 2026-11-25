import PDFDocument from 'pdfkit';
import { formatMoney } from '@paysplit/core';
import type { Statement, transactionDetail } from './transactions.ts';

type Detail = Awaited<ReturnType<typeof transactionDetail>>;

// PDF's built-in fonts have no naira sign, so documents spell the currency out.
const money = (value: number | bigint) => formatMoney(value).replace('₦', 'NGN ');
const plain = (value: string) => value.replaceAll('•', '*').replaceAll('₦', 'NGN ');

function render(draw: (doc: PDFKit.PDFDocument) => void, title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: { Title: title, Author: 'PaySplit' },
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc);
    doc.end();
  });
}

function letterhead(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  doc.save().circle(58, 60, 10).fill('#57a4ef').restore();
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text('Paysplit', 76, 53);
  doc.fontSize(20).text(title, 48, 96);
  doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text(plain(subtitle), 48, 122);
}

export function receiptPdf(t: Detail, timezone: string): Promise<Buffer> {
  return render((doc) => {
    letterhead(doc, 'Transaction receipt', t.reference);
    doc.roundedRect(48, 150, 499, 84, 10).fill('#f2f8fe');
    doc.fillColor('#6b7280').fontSize(10).text('Amount', 48, 166, { width: 499, align: 'center' });
    doc
      .font('Helvetica-Bold')
      .fontSize(24)
      .fillColor('#111')
      .text(money(t.amount), 48, 182, { width: 499, align: 'center' });
    doc.fontSize(10).fillColor('#16803c').text('Successful', 48, 214, { width: 499, align: 'center' });
    const when = new Date(t.completedAt ?? t.createdAt).toLocaleString('en-GB', {
      timeZone: timezone,
      dateStyle: 'long',
      timeStyle: 'short',
    });
    const rows: [string, string][] = [
      ['Type', TYPE_LABELS[t.type] ?? t.type],
      ['From', [t.source.label, t.source.detail].filter(Boolean).join(', ')],
      ['To', [t.destination.label, t.destination.detail].filter(Boolean).join(', ')],
      ['Fee', money(t.fee)],
      ['Date', `${when} (${timezone})`],
      ['Reference', t.reference],
      ...(t.providerReference ? ([['Provider reference', t.providerReference]] as [string, string][]) : []),
      ...(t.rule ? ([['Split rule', t.rule.name]] as [string, string][]) : []),
      ...(t.isTest ? ([['Environment', 'Test mode. No real money moved.']] as [string, string][]) : []),
    ];
    let y = 262;
    for (const [label, value] of rows) {
      doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text(label, 48, y, { width: 150 });
      doc.fillColor('#111').text(plain(value), 200, y, { width: 347, align: 'right' });
      y += Math.max(26, doc.heightOfString(plain(value), { width: 347 }) + 14);
      doc
        .moveTo(48, y - 8)
        .lineTo(547, y - 8)
        .strokeColor('#eef0f3')
        .stroke();
    }
  }, `Receipt ${t.reference}`);
}

export const TYPE_LABELS: Record<string, string> = {
  salary_received: 'Salary received',
  wallet_allocation: 'Wallet allocation',
  beneficiary_transfer: 'Beneficiary transfer',
  wallet_to_salary: 'Wallet to salary account',
  transfer_hold: 'Transfer sent',
  transfer_released: 'Transfer returned',
  transfer_reversed: 'Transfer reversed',
};

export function statementPdf(s: Statement, holder: string, timezone: string): Promise<Buffer> {
  const columns = [
    { label: 'Date', x: 48, width: 62 },
    { label: 'Description', x: 114, width: 158 },
    { label: 'Reference', x: 276, width: 92 },
    { label: 'In', x: 370, width: 58, right: true },
    { label: 'Out', x: 430, width: 58, right: true },
    { label: 'Balance', x: 490, width: 58, right: true },
  ];
  const short = (value: bigint) => (value === 0n ? '' : formatMoney(value).replace('₦', ''));
  return render((doc) => {
    letterhead(
      doc,
      'Account statement',
      `${holder}. ${s.accountLabel}. ${s.from} to ${s.to}. Amounts in NGN.`,
    );
    const summary: [string, bigint][] = [
      ['Opening balance', s.opening],
      ['Money in', s.totalIn],
      ['Money out', s.totalOut],
      ['Closing balance', s.closing],
    ];
    summary.forEach(([label, value], i) => {
      const x = 48 + i * 126;
      doc.roundedRect(x, 148, 120, 48, 8).fill('#f2f8fe');
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#6b7280')
        .text(label, x + 10, 157);
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#111')
        .text(money(value), x + 10, 172);
    });
    let y = 220;
    const header = () => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280');
      for (const c of columns)
        doc.text(c.label, c.x, y, { width: c.width, align: c.right ? 'right' : 'left' });
      y += 18;
    };
    header();
    if (s.lines.length === 0)
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#6b7280')
        .text('No movements in this period.', 48, y + 6);
    for (const line of s.lines) {
      const date = line.date.toLocaleDateString('en-GB', {
        timeZone: timezone,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
      const cells = [
        date,
        plain(line.description),
        line.reference,
        short(line.moneyIn),
        short(line.moneyOut),
        short(line.balance) || '0.00',
      ];
      doc.font('Helvetica').fontSize(8).fillColor('#111');
      const height = Math.max(
        ...cells.map((cell, i) => doc.heightOfString(cell, { width: columns[i]!.width })),
      );
      if (y + height > 770) {
        doc.addPage();
        y = 48;
        header();
        doc.font('Helvetica').fontSize(8).fillColor('#111');
      }
      cells.forEach((cell, i) =>
        doc.text(cell, columns[i]!.x, y, {
          width: columns[i]!.width,
          align: columns[i]!.right ? 'right' : 'left',
        }),
      );
      y += height + 8;
      doc
        .moveTo(48, y - 4)
        .lineTo(547, y - 4)
        .strokeColor('#eef0f3')
        .stroke();
    }
  }, 'PaySplit statement');
}

/** Quotes a CSV cell and defuses spreadsheet formulas, since descriptions contain text people typed. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

export function statementCsv(s: Statement): string {
  const rows = [
    ['Account', s.accountLabel],
    ['Period', `${s.from} to ${s.to}`],
    ['Opening balance (NGN)', decimal(s.opening)],
    [],
    ['Date (UTC)', 'Reference', 'Description', 'Type', 'Money in', 'Money out', 'Balance'],
    ...s.lines.map((l) => [
      l.date.toISOString(),
      l.reference,
      l.description,
      TYPE_LABELS[l.type] ?? l.type,
      l.moneyIn ? decimal(l.moneyIn) : '',
      l.moneyOut ? decimal(l.moneyOut) : '',
      decimal(l.balance),
    ]),
    [],
    ['Total', '', '', '', decimal(s.totalIn), decimal(s.totalOut), decimal(s.closing)],
  ];
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
