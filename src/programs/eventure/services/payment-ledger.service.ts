import type { Prisma } from "@prisma/client";

import { prisma } from "../../../core/db/prisma.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

type LedgerLineItemInput = {
  category: string;
  amount: number;
  description?: string | null;
  sourceImportBatchId?: string;
  sourceImportRowId?: string;
  metadata?: Prisma.InputJsonValue;
};

type RecordPaymentTransactionInput = {
  db?: DbClient;
  organizationId: string;
  eventId: string;
  contactCompanyId: string;
  participantId?: string | null;
  amountDue: number;
  amountPaid: number;
  paymentMethod?: string | null;
  notes?: string | null;
  changedByUserId?: string;
  transactionType?: string;
  source?: string;
  referenceKey?: string;
  transactionAt?: Date;
  lineItems?: LedgerLineItemInput[];
};

export async function recordEventurePaymentTransaction(input: RecordPaymentTransactionInput) {
  const db = input.db ?? prisma;
  const now = input.transactionAt ?? new Date();

  const lineItems = Array.isArray(input.lineItems) && input.lineItems.length > 0
    ? input.lineItems
    : [{
      category: "UNSPECIFIED",
      amount: input.amountPaid,
      description: input.notes,
    }];

  const rollupAmountPaid = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const rollupAmountDue = Math.max(input.amountDue, rollupAmountPaid);

  const existingPayment = await db.eventurePayment.findFirst({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      contactCompanyId: input.contactCompanyId,
    },
    orderBy: [{ updatedAt: "desc" }],
  });

  const payment = existingPayment
    ? await db.eventurePayment.update({
      where: { id: existingPayment.id },
      data: {
        participantId: input.participantId ?? existingPayment.participantId,
        amountDue: rollupAmountDue,
        amountPaid: rollupAmountPaid,
        balance: rollupAmountDue - rollupAmountPaid,
        paymentStatus: "confirmed",
        paymentMethod: input.paymentMethod ?? existingPayment.paymentMethod,
        paymentConfirmedAt: now,
        notes: input.notes ?? existingPayment.notes,
      },
    })
    : await db.eventurePayment.create({
      data: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: input.contactCompanyId,
        participantId: input.participantId ?? null,
        amountDue: rollupAmountDue,
        amountPaid: rollupAmountPaid,
        balance: rollupAmountDue - rollupAmountPaid,
        paymentStatus: "confirmed",
        paymentMethod: input.paymentMethod ?? null,
        paymentConfirmedAt: now,
        notes: input.notes ?? null,
      },
    });

  await db.eventurePaymentHistory.create({
    data: {
      organizationId: input.organizationId,
      paymentId: payment.id,
      paymentStatus: payment.paymentStatus,
      amountDue: payment.amountDue,
      amountPaid: payment.amountPaid,
      balance: payment.balance,
      paymentMethod: payment.paymentMethod,
      paymentConfirmedAt: payment.paymentConfirmedAt,
      notes: payment.notes,
      changedByUserId: input.changedByUserId ?? null,
    },
  });

  const transaction = await db.eventurePaymentTransaction.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      contactCompanyId: input.contactCompanyId,
      paymentId: payment.id,
      participantId: input.participantId ?? null,
      transactionType: input.transactionType ?? "payment",
      status: "confirmed",
      source: input.source ?? "manual",
      referenceKey: input.referenceKey ?? null,
      paymentMethod: input.paymentMethod ?? null,
      notes: input.notes ?? null,
      totalAmount: rollupAmountPaid,
      transactionAt: now,
      createdByUserId: input.changedByUserId ?? null,
    },
  });

  await db.eventurePaymentLineItem.createMany({
    data: lineItems.map((item) => ({
      organizationId: input.organizationId,
      transactionId: transaction.id,
      eventId: input.eventId,
      contactCompanyId: input.contactCompanyId,
      participantId: input.participantId ?? null,
      category: item.category,
      description: item.description ?? null,
      amount: item.amount,
      sourceImportBatchId: item.sourceImportBatchId,
      sourceImportRowId: item.sourceImportRowId,
      metadata: item.metadata,
    })),
  });

  return { payment, transaction };
}
