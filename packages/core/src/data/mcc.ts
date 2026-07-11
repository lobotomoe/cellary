/**
 * Mobile Country Codes (MCC) to country name mapping.
 *
 * Source: ITU-T Recommendation E.212
 * "The international identification plan for public networks and subscriptions"
 * PDF: https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-E.212B-2023-PDF-E.pdf
 * Operative bulletin: https://www.itu.int/pub/T-SP-E.212B
 *
 * MCC is the first 3 digits of IMSI and PLMN codes. Each entry maps
 * a 3-digit MCC string to the country/territory name as listed by ITU.
 *
 * This table covers assigned MCCs as of 2025. Some countries have multiple
 * MCCs (e.g. USA has 310-316); all are listed individually.
 */

// prettier-ignore
const MCC_TABLE: Record<string, string> = {
  // Test networks
  '001': 'Test Network',

  // Europe
  '202': 'Greece',
  '204': 'Netherlands',
  '206': 'Belgium',
  '208': 'France',
  '210': 'Monaco',
  '212': 'Andorra',
  '213': 'Spain',
  '214': 'Spain',
  '216': 'Hungary',
  '218': 'Bosnia and Herzegovina',
  '219': 'Croatia',
  '220': 'Serbia',
  '221': 'Kosovo',
  '222': 'Italy',
  '225': 'Vatican City',
  '226': 'Romania',
  '228': 'Switzerland',
  '230': 'Czech Republic',
  '231': 'Slovakia',
  '232': 'Austria',
  '234': 'United Kingdom',
  '235': 'United Kingdom',
  '238': 'Denmark',
  '240': 'Sweden',
  '242': 'Norway',
  '244': 'Finland',
  '246': 'Lithuania',
  '247': 'Latvia',
  '248': 'Estonia',
  '250': 'Russia',
  '255': 'Ukraine',
  '257': 'Belarus',
  '259': 'Moldova',
  '260': 'Poland',
  '262': 'Germany',
  '266': 'Gibraltar',
  '268': 'Portugal',
  '270': 'Luxembourg',
  '272': 'Ireland',
  '274': 'Iceland',
  '276': 'Albania',
  '278': 'Malta',
  '280': 'Cyprus',
  '282': 'Georgia',
  '283': 'Armenia',
  '284': 'Bulgaria',
  '286': 'Turkey',
  '288': 'Faroe Islands',
  '289': 'Abkhazia',
  '290': 'Greenland',
  '292': 'San Marino',
  '293': 'Slovenia',
  '294': 'North Macedonia',
  '295': 'Liechtenstein',
  '297': 'Montenegro',

  // North America
  '302': 'Canada',
  '308': 'Saint Pierre and Miquelon',
  '310': 'United States',
  '311': 'United States',
  '312': 'United States',
  '313': 'United States',
  '314': 'United States',
  '315': 'United States',
  '316': 'United States',

  // Caribbean
  '330': 'Puerto Rico',
  '332': 'US Virgin Islands',
  '334': 'Mexico',
  '338': 'Jamaica',
  '340': 'Guadeloupe',
  '342': 'Barbados',
  '344': 'Antigua and Barbuda',
  '346': 'Cayman Islands',
  '348': 'British Virgin Islands',
  '350': 'Bermuda',
  '352': 'Grenada',
  '354': 'Montserrat',
  '356': 'Saint Kitts and Nevis',
  '358': 'Saint Lucia',
  '360': 'Saint Vincent and the Grenadines',
  '362': 'Curacao',
  '363': 'Aruba',
  '364': 'Bahamas',
  '365': 'Anguilla',
  '366': 'Dominica',
  '368': 'Cuba',
  '370': 'Dominican Republic',
  '372': 'Haiti',
  '374': 'Trinidad and Tobago',
  '376': 'Turks and Caicos Islands',

  // Central & South America
  '400': 'Azerbaijan',
  '401': 'Kazakhstan',
  '402': 'Bhutan',
  '404': 'India',
  '405': 'India',
  '406': 'India',
  '410': 'Pakistan',
  '412': 'Afghanistan',
  '413': 'Sri Lanka',
  '414': 'Myanmar',
  '415': 'Lebanon',
  '416': 'Jordan',
  '417': 'Syria',
  '418': 'Iraq',
  '419': 'Kuwait',
  '420': 'Saudi Arabia',
  '421': 'Yemen',
  '422': 'Oman',
  '424': 'United Arab Emirates',
  '425': 'Israel',
  '426': 'Bahrain',
  '427': 'Qatar',
  '428': 'Mongolia',
  '429': 'Nepal',
  '430': 'United Arab Emirates',
  '431': 'United Arab Emirates',
  '432': 'Iran',
  '434': 'Uzbekistan',
  '436': 'Tajikistan',
  '437': 'Kyrgyzstan',
  '438': 'Turkmenistan',
  '440': 'Japan',
  '441': 'Japan',
  '450': 'South Korea',
  '452': 'Vietnam',
  '454': 'Hong Kong',
  '455': 'Macau',
  '456': 'Cambodia',
  '457': 'Laos',
  '460': 'China',
  '461': 'China',
  '466': 'Taiwan',
  '467': 'North Korea',
  '470': 'Bangladesh',
  '472': 'Maldives',

  // South America
  '704': 'Guatemala',
  '706': 'El Salvador',
  '708': 'Honduras',
  '710': 'Nicaragua',
  '712': 'Costa Rica',
  '714': 'Panama',
  '716': 'Peru',
  '722': 'Argentina',
  '724': 'Brazil',
  '730': 'Chile',
  '732': 'Colombia',
  '734': 'Venezuela',
  '736': 'Bolivia',
  '738': 'Guyana',
  '740': 'Ecuador',
  '742': 'French Guiana',
  '744': 'Paraguay',
  '746': 'Suriname',
  '748': 'Uruguay',

  // Africa
  '602': 'Egypt',
  '603': 'Algeria',
  '604': 'Morocco',
  '605': 'Tunisia',
  '606': 'Libya',
  '607': 'Gambia',
  '608': 'Senegal',
  '609': 'Mauritania',
  '610': 'Mali',
  '611': 'Guinea',
  '612': 'Ivory Coast',
  '613': 'Burkina Faso',
  '614': 'Niger',
  '615': 'Togo',
  '616': 'Benin',
  '617': 'Mauritius',
  '618': 'Liberia',
  '619': 'Sierra Leone',
  '620': 'Ghana',
  '621': 'Nigeria',
  '622': 'Chad',
  '623': 'Central African Republic',
  '624': 'Cameroon',
  '625': 'Cape Verde',
  '626': 'Sao Tome and Principe',
  '627': 'Equatorial Guinea',
  '628': 'Gabon',
  '629': 'Republic of the Congo',
  '630': 'Democratic Republic of the Congo',
  '631': 'Angola',
  '632': 'Guinea-Bissau',
  '633': 'Seychelles',
  '634': 'Sudan',
  '635': 'Rwanda',
  '636': 'Ethiopia',
  '637': 'Somalia',
  '638': 'Djibouti',
  '639': 'Kenya',
  '640': 'Tanzania',
  '641': 'Uganda',
  '642': 'Burundi',
  '643': 'Mozambique',
  '645': 'Zambia',
  '646': 'Madagascar',
  '647': 'Reunion',
  '648': 'Zimbabwe',
  '649': 'Namibia',
  '650': 'Malawi',
  '651': 'Lesotho',
  '652': 'Botswana',
  '653': 'Eswatini',
  '654': 'Comoros',
  '655': 'South Africa',
  '657': 'Eritrea',
  '658': 'South Sudan',

  // Oceania
  '505': 'Australia',
  '510': 'Indonesia',
  '514': 'East Timor',
  '515': 'Philippines',
  '520': 'Thailand',
  '525': 'Singapore',
  '528': 'Brunei',
  '530': 'New Zealand',
  '536': 'Nauru',
  '537': 'Papua New Guinea',
  '539': 'Tonga',
  '540': 'Solomon Islands',
  '541': 'Vanuatu',
  '542': 'Fiji',
  '544': 'American Samoa',
  '545': 'Kiribati',
  '546': 'New Caledonia',
  '547': 'French Polynesia',
  '548': 'Cook Islands',
  '549': 'Samoa',
  '550': 'Micronesia',
  '551': 'Marshall Islands',
  '552': 'Palau',
  '553': 'Tuvalu',

  // Satellite / international
  '901': 'International Networks',
}

/**
 * Resolve a 3-digit MCC to a country name.
 *
 * @returns Country name or undefined if MCC is unknown.
 */
export function resolveCountry(mcc: string): string | undefined {
  return MCC_TABLE[mcc]
}

/**
 * Check whether a string looks like a numeric PLMN (digits with optional dash).
 * Modems return these when they don't have an operator name table for the network.
 *
 * Examples: "28310", "283-10", "310-260"
 */
export function isNumericPlmn(value: string): boolean {
  return /^\d{3}-?\d{2,3}$/.test(value)
}

/**
 * Parse MCC from a PLMN string. Handles both "28310" and "283-10" formats.
 *
 * @returns 3-digit MCC string or undefined if not a valid PLMN.
 */
export function parseMcc(plmn: string): string | undefined {
  const match = /^(\d{3})-?\d{2,3}$/.exec(plmn)
  if (match === null) return undefined
  const [, mcc] = match
  return mcc
}

/**
 * Try to resolve a PLMN-like operator name to a human-readable label.
 *
 * If the value looks like a numeric PLMN (e.g. "283-10"), returns the
 * country name from the MCC table. Otherwise returns the value as-is
 * (it's already a real operator name).
 */
export function resolveOperatorName(operatorOrPlmn: string): string {
  if (!isNumericPlmn(operatorOrPlmn)) return operatorOrPlmn

  const mcc = parseMcc(operatorOrPlmn)
  if (mcc === undefined) return operatorOrPlmn

  const country = resolveCountry(mcc)
  if (country === undefined) return operatorOrPlmn

  // Return "Country (PLMN)" so the user still sees the raw code
  return `${country} (${operatorOrPlmn})`
}
