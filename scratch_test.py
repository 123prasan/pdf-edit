import fitz

def test_redact():
    # Create PDF with a grey background and some text
    doc = fitz.open()
    page = doc.new_page()
    page.draw_rect(page.rect, color=None, fill=(0.9, 0.9, 0.9)) # Grey background
    page.insert_text((50, 50), "This is text to delete.", fontsize=20)
    page.insert_text((50, 100), "This is text to keep.", fontsize=20)
    
    # Redact "delete"
    insts = page.search_for("delete")
    for inst in insts:
        page.add_redact_annot(inst, fill=None) # no fill color!
        
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
    
    doc.save("test_out.pdf")
    print("Done")

if __name__ == "__main__":
    test_redact()
