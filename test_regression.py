# Test A & B & C: Syntax errors
def missing_colon()
    pass

def missing_bracket():
    x = [1, 2, 3

# Test D: Typo NameError
def test_typo():
    prit("Hello World")

# Test E: Runtime NameError
def test_runtime():
    return user_input

# Test F: Logic Bug
def test_logic():
    # Should calculate sum of squares
    x = [1, 2, 3]
    return sum([n + n for n in x])
