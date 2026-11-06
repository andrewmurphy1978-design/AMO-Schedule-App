-- Product ingredient lines can be alternatives ("this OR that OR that"): lines of a format with the same choice_group are one choice.
ALTER TABLE product_ingredients ADD COLUMN choice_group INTEGER;
