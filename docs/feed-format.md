# Feed format

jscrawl exports a site's catalogue as one feed: a zip of two CSV files, the
format aether's product import reads.

| File | What it holds |
| --- | --- |
| `categories.csv` | the site's category tree, one row per category |
| `products.csv` | the products, one row per variant, in [Google's product data specification](https://support.google.com/merchants/answer/7052112) plus a few extension columns |

The categories come first: an import creates them before it files products under
them. Get a feed from a site's catalogue page in the dashboard, `GET
/api/sites/<id>/feed.zip`, or `npm run jscrawl -- --export-feed <site> <file.zip>`.

Only products whose own page has been scraped are exported: a product seen only
on a listing has no variant or price yet, and is left out until its page is
crawled. Archived products (gone from the site) are left out too.

## categories.csv

| Column | Value |
| --- | --- |
| `product_type` | the category's path from the root, levels joined by ` > `: `Tiles > Floor Tiles > Matt` |
| `description` | the category's intro text, plain text |
| `image_link` | the category's picture |
| `sort_order` | its place among its siblings in the site's menu |

Rows are sorted by path, so a parent comes before its children. A `>` inside a
category's own name is written as `›`, so it can't be read as a path separator.

## products.csv

Each row is a variant. The variants of one product share its `item_group_id`;
the product's own fields (title, description, category, attributes, add-ons) are
on its first row only and left empty on the rest.

| Column | Value |
| --- | --- |
| `id` | the variant's SKU in the feed: `<product code>-<variant code>`, or the product code for a product's only, unnamed variant |
| `item_group_id` | the product code, when the product has more than one variant |
| `title` | the product's name |
| `description` | the product's description, plain text |
| `price` | `<amount> <currency>`, the amount as saved, e.g. `135.0000 AUD`: the regular price; on sale, the was price |
| `sale_price` | the price now, when it is below the regular price |
| `availability` | `in_stock`, `out_of_stock`, `preorder` or `backorder` |
| `product_type` | the path of the product's primary category, as in `categories.csv` |
| `category_position` | the product's place in that category's listing |
| `image_link` | the variant's main image: a picture of the product alone if there is one (a tile's face, a sofa on a plain backdrop), else the first picture the site shows; the variant's own pictures before the whole product's |
| `additional_image_link` | the variant's other images, comma-separated, in the same order, so a row carries at most 5 images in all; scenes and props come after pictures of the product alone (a comma inside a url is written `%2C`) |
| `gtin` | the barcode (EAN, UPC) |
| `shipping_weight` | `<number> <unit>`, unit `kg`, `g`, `lb` or `oz` |
| `variant_options` | the variant's choices, `Name:Value` pairs joined by `\|`: `Colour:Grey\|Size:AU 4 - EUR 35` |
| `option_groups` | the product's add-ons, as JSON (below) |
| `product_attributes` | the product's specifications, as a JSON object of text values |

`variant_options` covers every option axis, not only Google's `color`, `size`,
`material` and `pattern`. A `:` or `|` inside a name, or `|` inside a value, is
replaced so the pairs read back as written.

### option_groups

Add-ons a shopper picks on top of the variant (a pizza's toppings, a gift box),
as a JSON array:

```json
[{"code": "Toppings", "name": "Toppings", "min_select": 0, "max_select": 3,
  "values": [{"code": "Olives", "label": "Olives", "price_extra": "2.00", "is_default": false}]}]
```

`min_select` and `max_select` bound how many values are chosen (`max_select` null:
no limit); `price_extra` is the value's price on top of the variant's, a decimal
string. Sold-out values are left out, and so is a group left without values. A
product without add-ons has `[]`.

### product_attributes

The product's specifications as `{"Name": "Value"}`: `{"Material": "Porcelain",
"Thickness": "9 mm"}`. An attribute with several values joins them with `, `. Two
attributes with the same name in different spec sections are told apart by
their section: `{"Dimensions: Width": "...", "Packaging: Width": "..."}`.

## CSV conventions

UTF-8, comma-separated, a header row, and RFC 4180 quoting: a cell holding a
comma, quote or line break is quoted, with its quotes doubled. Empty cells are
empty, not `null`.
