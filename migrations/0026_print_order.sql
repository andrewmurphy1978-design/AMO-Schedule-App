-- Optional position of the employee in the printed schedule when "order defined in the employee setup" is chosen (1 = first).
ALTER TABLE staff ADD COLUMN print_order INTEGER CHECK (print_order IS NULL OR (print_order >= 1 AND print_order <= 999));
