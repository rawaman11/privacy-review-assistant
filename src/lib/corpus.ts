// Clause corpus used to ground findings.
//
// Scope, as locked in the project's phase 1 planning:
//  - GDPR: consent/legal basis (Art. 6-7), data subject rights (Art. 12-22)
//  - CCPA: notice-at-collection (§1798.100), opt-out of sale/sharing (§1798.120)
//  - HIPAA Privacy Rule: general disclosure rule + minimum necessary (§164.502)
// Explicitly out of scope: enforcement mechanics, cross-border transfer
// machinery, breach-notification procedure — compliance-pro territory, not
// generalist territory, per the persona decision.
//
// Sources: gdpr-info.eu / privacy-regulation.eu (GDPR text mirrors of the
// official OJ text), California Legislative Information / FindLaw (CCPA),
// eCFR (HIPAA). Verify against primary sources before any real-world use —
// this corpus is a portfolio-project grounding set, not a compliance product.

export interface Clause {
  id: string;
  regulation: string;
  article: string;
  title: string;
  text: string;
  taxonomy_tags: string[];
}

export const CORPUS: Clause[] = [
  // ── GDPR: lawfulness and consent ──────────────────────────────────────────
  {
    id: "gdpr-art6",
    regulation: "GDPR",
    article: "Article 6",
    title: "Lawfulness of processing",
    text:
      "Processing shall be lawful only if and to the extent that at least one of the following applies: (a) the data subject has given consent to the processing of his or her personal data for one or more specific purposes; (b) processing is necessary for the performance of a contract to which the data subject is party or in order to take steps at the request of the data subject prior to entering into a contract; (c) processing is necessary for compliance with a legal obligation to which the controller is subject; (d) processing is necessary in order to protect the vital interests of the data subject or of another natural person; (e) processing is necessary for the performance of a task carried out in the public interest or in the exercise of official authority vested in the controller; (f) processing is necessary for the purposes of the legitimate interests pursued by the controller or by a third party, except where such interests are overridden by the interests or fundamental rights and freedoms of the data subject, in particular where the data subject is a child.",
    taxonomy_tags: ["non_compliance_no_legal_basis"],
  },
  {
    id: "gdpr-art7",
    regulation: "GDPR",
    article: "Article 7",
    title: "Conditions for consent",
    text:
      "1. Where processing is based on consent, the controller shall be able to demonstrate that the data subject has consented. 2. If consent is given in the context of a written declaration which also concerns other matters, the request for consent shall be presented clearly distinguishable from the other matters, in an intelligible and easily accessible form, using clear and plain language. 3. The data subject shall have the right to withdraw consent at any time, as easily as it was given, without affecting the lawfulness of processing before withdrawal. 4. When assessing whether consent is freely given, utmost account shall be taken of whether performance of a contract is conditional on consent to processing not necessary for that contract.",
    taxonomy_tags: ["non_compliance_no_legal_basis", "unawareness_non_transparency"],
  },

  // ── GDPR: transparency and information duties ─────────────────────────────
  {
    id: "gdpr-art12",
    regulation: "GDPR",
    article: "Article 12",
    title: "Transparent information, communication and modalities for the exercise of data subject rights",
    text:
      "1. The controller shall provide information relating to processing to the data subject in a concise, transparent, intelligible and easily accessible form, using clear and plain language. 2. The controller shall facilitate the exercise of data subject rights under Articles 15 to 22. 3. The controller shall act on a request under Articles 15 to 22 without undue delay and within one month, extendable by two further months where necessary, with reasons given. 4. If the controller does not act on the request, it shall inform the data subject without delay and within one month of the reasons and of the possibility of lodging a complaint with a supervisory authority. 5. Information and actions under Articles 13-22 and 34 shall be provided free of charge, except where requests are manifestly unfounded or excessive.",
    taxonomy_tags: ["unawareness_non_transparency"],
  },
  {
    id: "gdpr-art13",
    regulation: "GDPR",
    article: "Article 13",
    title: "Information to be provided where personal data are collected from the data subject",
    text:
      "1. At the time personal data are obtained, the controller shall provide the data subject with: the identity and contact details of the controller; the DPO's contact details, where applicable; the purposes of processing and legal basis; where based on legitimate interests, those interests; recipients or categories of recipients; details of any intended transfer to a third country. 2. In addition, the controller shall provide: the retention period or criteria to determine it; the existence of rights of access, rectification, erasure, restriction, objection and portability; where based on consent, the right to withdraw it; the right to lodge a complaint with a supervisory authority; whether provision of the data is a statutory or contractual requirement and the consequences of failure to provide it; the existence of automated decision-making, including profiling, and meaningful information about the logic involved and the significance and envisaged consequences for the data subject. 3. Where data will be further processed for another purpose, the controller shall inform the data subject of that other purpose before further processing. 4. Paragraphs 1-3 do not apply where the data subject already has the information.",
    taxonomy_tags: ["unawareness_non_transparency"],
  },
  {
    id: "gdpr-art14",
    regulation: "GDPR",
    article: "Article 14",
    title: "Information to be provided where personal data have not been obtained from the data subject",
    text:
      "1-2. Where data was not obtained directly from the data subject, the controller shall provide the same categories of information as under Article 13, plus the categories of personal data concerned and the source of the data, including whether it came from publicly accessible sources. 3. This information must be provided within a reasonable period, at the latest within one month; or at the time of first communication with the data subject; or at the time of first disclosure to another recipient, if disclosure is envisaged. 4. Where data will be further processed for another purpose, the controller shall inform the data subject before further processing. 5. Paragraphs 1-4 do not apply where the data subject already has the information, providing it proves impossible or disproportionately effortful, obtaining or disclosure is expressly laid down by law with appropriate safeguards, or the data must remain confidential under a professional secrecy obligation.",
    taxonomy_tags: ["unawareness_non_transparency", "disclosure_undisclosed_sharing"],
  },

  // ── GDPR: data subject rights ─────────────────────────────────────────────
  {
    id: "gdpr-art15",
    regulation: "GDPR",
    article: "Article 15",
    title: "Right of access by the data subject",
    text:
      "1. The data subject has the right to obtain confirmation of whether their data is processed, and access to it and to: the purposes of processing; categories of data concerned; recipients or categories of recipients, in particular in third countries; the envisaged retention period or criteria to determine it; the existence of rights to rectification, erasure, restriction and objection; the right to lodge a complaint; source of the data where not collected from the data subject; and the existence of automated decision-making, including profiling, with meaningful information about the logic, significance and envisaged consequences. 2. Where data is transferred to a third country, the data subject has the right to be informed of the appropriate safeguards. 3. The controller shall provide a copy of the data undergoing processing; further copies may incur a reasonable administrative fee. 4. The right to a copy shall not adversely affect the rights and freedoms of others.",
    taxonomy_tags: ["unawareness_non_transparency", "disclosure_undisclosed_sharing"],
  },
  {
    id: "gdpr-art16",
    regulation: "GDPR",
    article: "Article 16",
    title: "Right to rectification",
    text:
      "The data subject has the right to obtain from the controller, without undue delay, rectification of inaccurate personal data, and to have incomplete data completed, including by means of a supplementary statement.",
    taxonomy_tags: ["non_compliance_no_legal_basis"],
  },
  {
    id: "gdpr-art17",
    regulation: "GDPR",
    article: "Article 17",
    title: "Right to erasure ('right to be forgotten')",
    text:
      "1. The data subject has the right to obtain erasure of personal data without undue delay where: the data is no longer necessary for the purpose it was collected for; the data subject withdraws consent and there is no other legal ground; the data subject objects to processing and there are no overriding legitimate grounds; the data has been unlawfully processed; erasure is required for compliance with a legal obligation; or the data was collected in relation to a child's consent to information society services. 2. Where the data has been made public, the controller must take reasonable steps to inform other controllers processing it that erasure has been requested. 3. Paragraphs 1-2 do not apply to the extent processing is necessary for exercising freedom of expression, compliance with a legal obligation or public-interest task, public health reasons, archiving/research/statistical purposes, or the establishment, exercise or defence of legal claims.",
    taxonomy_tags: ["non_compliance_no_legal_basis", "detectability_undisclosed_logging_retention"],
  },
  {
    id: "gdpr-art18",
    regulation: "GDPR",
    article: "Article 18",
    title: "Right to restriction of processing",
    text:
      "1. The data subject has the right to obtain restriction of processing where: accuracy of the data is contested, for a period allowing verification; processing is unlawful and the data subject opposes erasure, requesting restriction instead; the controller no longer needs the data but the data subject requires it for legal claims; or the data subject has objected to processing pending verification of whether the controller's legitimate grounds override theirs. 2. Where processing is restricted, the data may, storage aside, only be processed with consent or for legal claims, protection of another's rights, or important public interest. 3. The data subject shall be informed before a restriction is lifted.",
    taxonomy_tags: ["non_compliance_no_legal_basis"],
  },
  {
    id: "gdpr-art19",
    regulation: "GDPR",
    article: "Article 19",
    title: "Notification obligation regarding rectification, erasure or restriction",
    text:
      "The controller shall communicate any rectification, erasure or restriction of processing to each recipient to whom the data has been disclosed, unless this proves impossible or involves disproportionate effort. The controller shall inform the data subject about those recipients if requested.",
    taxonomy_tags: ["disclosure_undisclosed_sharing"],
  },
  {
    id: "gdpr-art20",
    regulation: "GDPR",
    article: "Article 20",
    title: "Right to data portability",
    text:
      "1. Where processing is based on consent or a contract and carried out by automated means, the data subject has the right to receive their personal data in a structured, commonly used, machine-readable format, and to transmit it to another controller without hindrance. 2. The data subject has the right to have data transmitted directly from one controller to another, where technically feasible. 3. This right is without prejudice to Article 17 and does not apply to processing necessary for a public-interest task. 4. This right shall not adversely affect the rights and freedoms of others.",
    taxonomy_tags: ["non_compliance_no_legal_basis"],
  },
  {
    id: "gdpr-art21",
    regulation: "GDPR",
    article: "Article 21",
    title: "Right to object",
    text:
      "1. The data subject has the right to object, on grounds relating to their particular situation, to processing based on public-interest task or legitimate interests, including profiling; the controller must stop unless it demonstrates compelling legitimate grounds overriding the data subject's interests, or the processing is for legal claims. 2-3. Where data is processed for direct marketing, the data subject has an unconditional right to object at any time, including to related profiling, and processing for that purpose must stop. 4. This right must be explicitly brought to the data subject's attention, presented clearly and separately, at the latest at the time of first communication. 5. The right may be exercised by automated means using technical specifications. 6. For research/statistical purposes, the data subject may object unless processing is necessary for a public-interest task.",
    taxonomy_tags: ["non_compliance_no_legal_basis", "unawareness_non_transparency"],
  },
  {
    id: "gdpr-art22",
    regulation: "GDPR",
    article: "Article 22",
    title: "Automated individual decision-making, including profiling",
    text:
      "1. The data subject has the right not to be subject to a decision based solely on automated processing, including profiling, which produces legal effects or similarly significantly affects them. 2. This does not apply where the decision is necessary for a contract, authorised by law with safeguards, or based on explicit consent. 3. In those cases the controller shall implement suitable measures, including at least the right to obtain human intervention, to express a view and to contest the decision. 4. Such decisions shall not be based on special categories of data unless explicit consent or substantial public interest applies, with suitable safeguards.",
    taxonomy_tags: ["non_compliance_no_legal_basis", "linkability_identifiability"],
  },

  // ── CCPA ───────────────────────────────────────────────────────────────────
  {
    id: "ccpa-1798.100",
    regulation: "CCPA",
    article: "Cal. Civ. Code § 1798.100",
    title: "Notice at collection and general duties of businesses",
    text:
      "(a) A business that controls the collection of a consumer's personal information shall, at or before the point of collection, inform consumers of: (1) the categories of personal information to be collected and the purposes for which they are collected or used, and whether that information is sold or shared, and shall not collect additional categories or use data for incompatible purposes without providing notice consistent with this section; (2) if sensitive personal information is collected, the categories and purposes, and whether it is sold or shared; (3) the length of time the business intends to retain each category of personal information, or the criteria used to determine that period, and shall not retain data longer than reasonably necessary for the disclosed purpose. (c) A business's collection, use, retention and sharing of personal information shall be reasonably necessary and proportionate to the disclosed purpose. (d) A business that sells or shares personal information, or discloses it to a service provider/contractor, must have a contract limiting use to specified purposes and requiring the same level of privacy protection. (e) A business must implement reasonable security procedures appropriate to the nature of the information.",
    taxonomy_tags: ["unawareness_non_transparency", "detectability_undisclosed_logging_retention"],
  },
  {
    id: "ccpa-1798.120",
    regulation: "CCPA",
    article: "Cal. Civ. Code § 1798.120",
    title: "Consumers' right to opt out of sale or sharing of personal information",
    text:
      "(a) A consumer has the right, at any time, to direct a business that sells or shares personal information to third parties not to sell or share it (the right to opt out). (b) A business that sells or shares personal information shall provide notice that this information may be sold or shared and that consumers have the right to opt out. (c) A business shall not sell or share personal information of a consumer it has actual knowledge is under 16 without affirmative authorization (from the consumer if 13-15, or a parent/guardian if under 13); willful disregard of age is deemed actual knowledge. (d) Once a business receives an opt-out direction, or lacks consent for a minor, it is prohibited from selling or sharing that consumer's personal information unless the consumer subsequently provides consent.",
    taxonomy_tags: ["disclosure_undisclosed_sharing", "unawareness_non_transparency"],
  },

  // ── HIPAA Privacy Rule ───────────────────────────────────────────────────────
  {
    id: "hipaa-164.502a",
    regulation: "HIPAA",
    article: "45 CFR § 164.502(a)",
    title: "Uses and disclosures of protected health information: general rule",
    text:
      "A covered entity or business associate may not use or disclose protected health information except as permitted or required by the Privacy Rule. Permitted uses and disclosures include: to the individual; for treatment, payment, or health care operations; incident to an otherwise permitted use, subject to the minimum-necessary and safeguard requirements; pursuant to a valid authorization; pursuant to an agreement or as otherwise permitted for specified purposes (e.g. facility directories, involvement in care); and as otherwise permitted under the Rule's specific provisions (public health, research, law enforcement, etc., each with their own conditions). A covered entity is required to disclose PHI to the individual upon a valid access or accounting request, and to the Secretary of HHS for compliance investigations. A covered entity or business associate may not sell protected health information except pursuant to a valid authorization that accounts for the sale.",
    taxonomy_tags: ["disclosure_undisclosed_sharing", "non_compliance_no_legal_basis"],
  },
  {
    id: "hipaa-164.502b",
    regulation: "HIPAA",
    article: "45 CFR § 164.502(b) / 164.514(d)",
    title: "Minimum necessary standard",
    text:
      "When using, disclosing, or requesting protected health information, a covered entity or business associate must make reasonable efforts to limit the information to the minimum necessary to accomplish the intended purpose. This requirement does not apply to: disclosures to or requests by a health care provider for treatment; uses or disclosures made to the individual; uses or disclosures made pursuant to a valid authorization; disclosures to the Secretary of HHS for compliance purposes; uses or disclosures required by law; and uses or disclosures required for the covered entity's own compliance with the Privacy Rule. Implementation requires identifying persons or classes of persons in the workforce who need access, and the category of PHI needed for their role, with reasonable efforts to limit access accordingly.",
    taxonomy_tags: ["detectability_undisclosed_logging_retention", "disclosure_undisclosed_sharing"],
  },
];
