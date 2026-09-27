-- Allow a payment with no client attached.
--
-- `payments.client_id` was NOT NULL, which quietly assumed every payment
-- belongs to someone the shop has a record of. It does not: a stranger buying
-- a tin of pomade with cash is one of the most ordinary transactions in a
-- barbershop, and forcing a client row for it would either block the sale or
-- fill the database with junk contacts.
--
-- Appointment payments still carry a client, because an appointment always
-- has one.

ALTER TABLE payments
    ALTER COLUMN client_id DROP NOT NULL;

-- A payment must still be attributable to something: a client, an
-- appointment, or the checkout that collected it.
ALTER TABLE payments
    ADD CONSTRAINT payment_is_attributable CHECK (
        client_id IS NOT NULL
        OR appointment_id IS NOT NULL
        OR checkout_id IS NOT NULL
    );
