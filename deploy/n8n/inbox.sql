CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE SCHEMA IF NOT EXISTS rawmat_notifications;
REVOKE ALL ON SCHEMA rawmat_notifications FROM PUBLIC;

CREATE TABLE IF NOT EXISTS rawmat_notifications.settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    signing_key bytea NOT NULL CHECK (octet_length(signing_key) = 32)
);

CREATE TABLE IF NOT EXISTS rawmat_notifications.inbox (
    id uuid PRIMARY KEY,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz
);

CREATE OR REPLACE FUNCTION rawmat_notifications.accept(
    event_id text, signed_at text, signature text, encoded_body text
) RETURNS TABLE (accepted boolean, id text, status_code integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    signing_key_bytes bytea;
    body_bytes bytea;
    digest_expected bytea;
    digest_provided bytea;
    payload_json jsonb;
BEGIN
    IF event_id IS NULL OR event_id !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
       OR signed_at IS NULL OR signed_at !~ '^[0-9]{10,12}$'
       OR signature IS NULL OR signature !~ '^sha256=[0-9a-f]{64}$' THEN
        RETURN QUERY SELECT false, NULL::text, 401;
        RETURN;
    END IF;
    IF abs(extract(epoch FROM clock_timestamp()) - signed_at::bigint) > 300 THEN
        RETURN QUERY SELECT false, NULL::text, 401;
        RETURN;
    END IF;
    IF encoded_body IS NULL OR length(encoded_body) NOT BETWEEN 4 AND 10924
       OR length(encoded_body) % 4 <> 0 OR encoded_body !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
        RETURN QUERY SELECT false, NULL::text, 400;
        RETURN;
    END IF;

    SELECT setting.signing_key INTO signing_key_bytes
    FROM rawmat_notifications.settings AS setting
    WHERE setting.singleton;
    IF signing_key_bytes IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, 503;
        RETURN;
    END IF;

    body_bytes := decode(encoded_body, 'base64');
    digest_expected := public.hmac(convert_to(signed_at || '.' || event_id || '.', 'UTF8') || body_bytes,
        signing_key_bytes, 'sha256');
    digest_provided := decode(substring(signature FROM 8), 'hex');
    IF (SELECT sum(get_byte(digest_expected, i) # get_byte(digest_provided, i)) FROM generate_series(0, 31) AS g(i)) <> 0 THEN
        RETURN QUERY SELECT false, NULL::text, 401;
        RETURN;
    END IF;

    BEGIN
        payload_json := convert_from(body_bytes, 'UTF8')::jsonb;
    EXCEPTION WHEN invalid_text_representation OR character_not_in_repertoire THEN
        RETURN QUERY SELECT false, NULL::text, 400;
        RETURN;
    END;
    IF jsonb_typeof(payload_json) IS DISTINCT FROM 'object'
       OR (payload_json ->> 'id') IS DISTINCT FROM event_id
       OR jsonb_typeof(payload_json -> 'recipients') IS DISTINCT FROM 'array'
       OR jsonb_typeof(payload_json -> 'message') IS DISTINCT FROM 'string' THEN
        RETURN QUERY SELECT false, NULL::text, 400;
        RETURN;
    END IF;

    INSERT INTO rawmat_notifications.inbox (id, payload) VALUES (event_id::uuid, payload_json)
    ON CONFLICT ON CONSTRAINT inbox_pkey DO NOTHING;
    RETURN QUERY SELECT true, event_id, 202;
END;
$$;

REVOKE ALL ON FUNCTION rawmat_notifications.accept(text, text, text, text) FROM PUBLIC;
