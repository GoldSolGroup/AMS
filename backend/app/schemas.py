from typing import Optional
from pydantic import BaseModel


class LoginIn(BaseModel):
    email: str
    password: str


class CreateUserIn(BaseModel):
    fullName: str
    email: Optional[str] = None
    password: Optional[str] = None
    role: str = "Custodian"
    missionId: Optional[str] = None


class ActionRequestIn(BaseModel):
    type: str  # Transfer | Reclassification | Fair Valuation
    payload: dict
    reason: Optional[str] = ""


class ReviewIn(BaseModel):
    note: Optional[str] = ""


class MissionCreate(BaseModel):
    name: str
    region: Optional[str] = None


class MissionUpdate(BaseModel):
    region: Optional[str] = None
    isHeadOffice: Optional[bool] = None


class TenantUpdate(BaseModel):
    org_name: Optional[str] = None
    logo_url: Optional[str] = None
    primary_color: Optional[str] = None
    accent_color: Optional[str] = None
    secondary_color: Optional[str] = None
    theme_name: Optional[str] = None
    same_region_requires_approval: Optional[bool] = None


class ClassCreate(BaseModel):
    name: str
    type: str
    usefulLifeYears: Optional[int] = None


class ClassUpdate(BaseModel):
    active: Optional[bool] = None
    usefulLifeYears: Optional[int] = None


class ScoaIn(BaseModel):
    fund: Optional[str] = ""
    func: Optional[str] = ""
    item: Optional[str] = ""


class AssetCreate(BaseModel):
    barcode: str
    desc: str
    category: str
    location: Optional[str] = None
    room: Optional[str] = ""
    custodian: Optional[str] = ""
    purchaseDate: Optional[str] = None
    price: float = 0
    currency: Optional[str] = "ZAR"
    costCentre: Optional[str] = ""
    serial: Optional[str] = ""
    poNumber: Optional[str] = ""
    invoiceRef: Optional[str] = ""
    fundingSource: Optional[str] = "Voted Funds"
    scoa: Optional[ScoaIn] = None


class AssetUpdate(BaseModel):
    location: Optional[str] = None
    custodian: Optional[str] = None
    room: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    price: Optional[float] = None
    description: Optional[str] = None
    serial: Optional[str] = None
    costCentre: Optional[str] = None
    poNumber: Optional[str] = None
    invoiceRef: Optional[str] = None


class HistoryCreate(BaseModel):
    type: str
    note: Optional[str] = ""
    actor: Optional[str] = "System"


class PhotoCreate(BaseModel):
    url: str


class DocumentCreate(BaseModel):
    name: str
    url: Optional[str] = None


class DisposalCreate(BaseModel):
    method: str
    reason: Optional[str] = ""
    value: float = 0


class FairValueCreate(BaseModel):
    value: float
    justification: str
    actor: Optional[str] = "System"


class MergeAssetsIn(BaseModel):
    keepId: str
    removeIds: list[str]
    actor: Optional[str] = "System"


class InvoiceCreate(BaseModel):
    ref: str
    amount: float


class RetentionCreate(BaseModel):
    pct: float
    surety: Optional[str] = ""


class CessionCreate(BaseModel):
    beneficiary: str
    amount: float


class BoqCreate(BaseModel):
    item: str
    amount: float


class CapLine(BaseModel):
    desc: str
    value: float


class CapitaliseIn(BaseModel):
    lines: list[CapLine]
    location: Optional[str] = "Head Office (OR Tambo Bld)"


class CycleCreate(BaseModel):
    scope: str
    due: Optional[str] = None
    assetIds: list[str] = []


class ScanIn(BaseModel):
    assetId: str
    verifiedBy: Optional[str] = "Unknown Officer"


class CloseCycleIn(BaseModel):
    missingAssetIds: list[str] = []


class MaintenanceCreate(BaseModel):
    assetId: str
    desc: str
    due: Optional[str] = None


class MaintenanceUpdate(BaseModel):
    status: str


class CorrectionCreate(BaseModel):
    assetId: Optional[str] = None
    reason: str
    evidence: Optional[str] = ""
    approver: Optional[str] = ""


class TrainingUpdate(BaseModel):
    status: str


class TicketCreate(BaseModel):
    subject: str
    priority: str = "Medium"
    sla: Optional[str] = None


class TicketUpdate(BaseModel):
    status: str


class MilestoneUpdate(BaseModel):
    status: str


class GlUpdate(BaseModel):
    glCode: str


class MigrationRunCreate(BaseModel):
    legacyCount: Optional[int] = None
    legacyValue: Optional[float] = None
    migratedCount: Optional[int] = None
    migratedValue: Optional[float] = None


class TeamUpdate(BaseModel):
    status: Optional[str] = None
    role: Optional[str] = None
    missionId: Optional[str] = None


class PasswordPolicyUpdate(BaseModel):
    minLength: int
    complexity: bool
    expiryDays: int
    historyCount: int


class ActivityCreate(BaseModel):
    message: str
