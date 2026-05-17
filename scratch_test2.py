import fitz

doc = fitz.open("test_out.pdf")
page = doc[0]
print(page.get_text("dict"))
