BEGIN;
INSERT INTO characters (name, attack) VALUES ('총웨', 100);
INSERT INTO characters VALUES ('슈', 120);
INSERT INTO items VALUES ('검, "강철"', 500);
SELECT name, attack FROM characters WHERE attack >= 100 ORDER BY attack DESC;
COMMIT;
SELECT COUNT(*) FROM characters;
