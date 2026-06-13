def process_data(data, multiplier)
    # Syntax bug 1: Missing colon
    # Runtime bug 1: data + multiplier where data is list and multiplier is int
    result = data + multiplier
    # Logic bug 1: Should multiply but adding instead
    return result

def calculate_stats(numbers):
    # Runtime bug 2: Division by zero if numbers is empty
    average = sum(numbers) / len(numbers)
    # Logic bug 2: returning sum instead of average
    return sum(numbers)

def main():
    val = process_data([1, 2, 3], 2)
    stats = calculate_stats([])
    
    # Syntax bug 2: Missing closing quote
    print("Stats are: )
    
    # Syntax bug 3: Missing closing parenthesis
    print(val

if __name__ == "__main__":
    main()
